// Scenario data for the renderer harness. Pure values — no IO, no imports from
// the main process, nothing that could resolve a real path.
//
// A scenario exists to make ONE visual state reachable on demand. States that
// are easy to produce by using the app do not need one; states that require a
// corrupt baseline file, a connector mid-failure, or thirty rows under a tall
// notice do, and those are exactly the ones that used to go unreviewed.

import type { Category, Severity } from '@xcg/shared';
import type { IpcConfigEntry, StatusResult } from '@xcg/shared/config';

import type {
  ConnectorAuthAlert,
  DetectionPageResult,
  DetectionRowSlim,
  EnrichableEvent,
  RetentionBannerInfo,
} from '../../shared/types.js';
import type { BaselineHistoryEntry } from '../lib/xcgApi.js';

export interface Scenario {
  id: string;
  label: string;
  /** What to look at, printed above the app frame. */
  note: string;
  entries: readonly IpcConfigEntry[];
  events: EnrichableEvent[];
  rows: DetectionRowSlim[];
  authAlerts: ConnectorAuthAlert[];
  baseline: Record<string, BaselineHistoryEntry[]>;
  retention: RetentionBannerInfo | null;
  /** Drives cchookStatus().pendingNotice — the tall notice above Detections. */
  hookVanishedTs: string | null;
}

const CONFIG_PATH = '/fixtures/claude_desktop_config.json';

export function statusFor(entries: readonly IpcConfigEntry[]): StatusResult {
  return {
    ok: true,
    configPresent: true,
    configPath: CONFIG_PATH,
    entries,
    summary: {
      wrappable: entries.filter((e) => e.kind === 'wrappable').length,
      alreadyWrapped: entries.filter((e) => e.kind === 'skipped' && e.reason === 'already-wrapped')
        .length,
      skippedOther: entries.filter((e) => e.kind === 'skipped' && e.reason !== 'already-wrapped')
        .length,
    },
  };
}

const remote = (name: string, url: string): IpcConfigEntry => ({
  kind: 'skipped',
  name,
  reason: 'already-wrapped',
  transport: 'http',
  endpoint: url,
});

const TWO_CONNECTORS: readonly IpcConfigEntry[] = [
  remote('notion', 'https://mcp.notion.com/mcp'),
  remote('stripe', 'https://mcp.stripe.com'),
];

// --- baseline lifecycle ------------------------------------------------------

const bl = (
  mcp: string,
  ts: string,
  event: BaselineHistoryEntry['event'],
  over: Partial<BaselineHistoryEntry> = {},
): BaselineHistoryEntry => ({ mcp, ts, event, ...over });

// All five kinds, on both connectors, so the card shows the neutral history
// AND the two that are warnings (snapshot_incomplete, reseeded/corrupt).
const BASELINE_BOTH: Record<string, BaselineHistoryEntry[]> = {
  notion: [
    bl('notion', '2026-09-24T10:47:00.000Z', 'snapshot_incomplete', { section: 'resources' }),
    bl('notion', '2026-09-24T09:31:00.000Z', 'projection_migrated', { fromVersion: 0, toVersion: 1 }),
    bl('notion', '2026-09-24T08:12:00.000Z', 'reseeded', { reason: 'absent', section: 'prompts' }),
    bl('notion', '2026-09-24T08:10:02.000Z', 'section_initialized', { section: 'prompts' }),
    bl('notion', '2026-09-24T08:10:00.000Z', 'migrated', {
      fromVersion: 1,
      toVersion: 2,
      coverageExpanded: [
        'tools[].title',
        'tools[].outputSchema',
        'tools[].annotations',
        'section:resources',
        'section:resource_templates',
        'section:prompts',
        'section:discovery',
      ],
    }),
  ],
  stripe: [
    bl('stripe', '2026-09-24T11:58:00.000Z', 'projection_migrated', { fromVersion: 0, toVersion: 1 }),
    bl('stripe', '2026-09-24T11:20:00.000Z', 'reseeded', { reason: 'corrupt', section: 'tools' }),
    bl('stripe', '2026-09-24T09:05:00.000Z', 'snapshot_incomplete', { section: 'tools' }),
    bl('stripe', '2026-09-24T08:12:01.000Z', 'section_initialized', { section: 'resources' }),
    bl('stripe', '2026-09-24T08:12:00.000Z', 'migrated', {
      fromVersion: 1,
      toVersion: 2,
      coverageExpanded: ['tools[].title', 'section:prompts', 'section:discovery'],
    }),
  ],
};

// --- detections --------------------------------------------------------------

const CATS: Category[] = [
  'prompt_injection',
  'credential_detected',
  'tool_manifest_changed',
  'data_export_warning',
  'email_send_warning',
  'pii_detected',
];
const SEVS: Severity[] = ['low', 'medium', 'high', 'critical'];

/** `n` rows, newest first, spread over the last hours. */
function manyRows(n: number): DetectionRowSlim[] {
  const base = Date.parse('2026-09-24T12:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(3, '0')}`,
    ts: new Date(base - i * 7 * 60_000).toISOString(),
    mcp: i % 3 === 0 ? 'stripe' : i % 3 === 1 ? 'notion' : 'claude-code',
    type: 'mcp.request' as const,
    category: CATS[i % CATS.length]!,
    severity: SEVS[i % SEVS.length]!,
    source: (i % 3 === 2 ? 'claude-code' : 'wrapper') as DetectionRowSlim['source'],
    toolName: ['search', 'create_page', 'list_charges', 'send_email', 'export_rows'][i % 5]!,
    method: 'tools/call',
    outcome: i % 9 === 0 ? ('error' as const) : ('ok' as const),
  }));
}

function rowsToEvents(rows: readonly DetectionRowSlim[]): EnrichableEvent[] {
  return rows.map((r, i) => ({
    id: r.id,
    ts: r.ts,
    session: 'harness',
    mcp: r.mcp,
    type: 'mcp.request' as const,
    method: 'tools/call',
    rpcId: i + 1,
    direction: 'client_to_server' as const,
    detection: {
      category: r.category,
      severity: r.severity,
      findings: [{ type: 'harness_fixture', location: 'arguments' }],
    },
    ...(r.source === 'claude-code' ? { source: 'claude-code' } : {}),
  }));
}

const FEW = manyRows(4);
const THIRTY = manyRows(30);

// --- scenarios ---------------------------------------------------------------

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'baseline',
    label: 'Connector card · baseline history',
    note:
      'Setup → pick notion, then stripe. Each card lists all five baseline kinds. ' +
      'snapshot_incomplete and reseeded/corrupt must render as warnings in the auth strip; ' +
      'the other three are neutral history. Detections must stay empty of them.',
    entries: TWO_CONNECTORS,
    events: rowsToEvents(FEW),
    rows: FEW,
    authAlerts: [],
    baseline: BASELINE_BOTH,
    retention: null,
    hookVanishedTs: null,
  },
  {
    id: 'detections-scroll',
    label: 'Detections · tall notice + 30 rows',
    note:
      'Detections tab. A hook-removed notice and a log-size banner sit above the list, ' +
      'which holds 30 rows. Scroll to the last row and back: the notice must not push the ' +
      'list out of its scroll container, and the header must stay reachable.',
    entries: TWO_CONNECTORS,
    events: rowsToEvents(THIRTY),
    rows: THIRTY,
    authAlerts: [
      {
        mcp: 'stripe',
        lastFailureTs: '2026-09-24T11:31:00.000Z',
        message: 'oauth refresh rejected (invalid_grant)',
      },
    ],
    baseline: BASELINE_BOTH,
    retention: { totalBytes: 1_900_000_000, sizeWarnBytes: 1_000_000_000 },
    hookVanishedTs: '2026-09-24T11:45:00.000Z',
  },
];

export function pageFor(s: Scenario): DetectionPageResult {
  const counts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of s.rows) counts[r.severity] += 1;
  return {
    rows: s.rows,
    total: s.rows.length,
    totalMatching: s.rows.length,
    severityCounts: counts,
    categoryFilteredTotal: s.rows.length,
    nextCursor: null,
    facets: {
      tools: [...new Set(s.rows.map((r) => r.toolName).filter((t): t is string => t !== undefined))],
      ccSessions: [],
      projects: [],
    },
    authAlerts: [...s.authAlerts],
    retention: s.retention,
  };
}

export function scenarioById(id: string | null): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
}
