// The fake `window.xcg`, typed as the real XcgApi.
//
// WHY THE TYPE MATTERS. `window.xcg` is the ONLY seam between the renderer and
// the main process. Declaring the fake as XcgApi means a component that starts
// calling a method the harness does not implement is a typecheck error, not a
// runtime surprise that silently falls through to something real — there is
// nothing real here to fall through to.
//
// Everything below is an in-memory value. No fetch, no import of a main-process
// module, no Node builtin (the renderer build guard rejects those anyway).

import type { XcgApi, BaselineHistoryEntry } from '../lib/xcgApi.js';
import { fakePage } from './fake-page.js';
import { statusFor, type Scenario } from './fixtures.js';

const never = async (): Promise<never> => {
  // A harness click that reaches one of these means the component wants a real
  // side effect. Failing loudly is the point: silently resolving would let a
  // reviewer believe an action worked.
  throw new Error('[harness] this action needs the main process and is not available here');
};

export function buildFakeApi(s: Scenario): XcgApi {
  const baselineFor = async (mcp: string): Promise<BaselineHistoryEntry[]> =>
    s.baseline[mcp] ?? [];

  return {
    listDetections: async () => ({
      events: s.events,
      authAlerts: [...s.authAlerts],
      retention: s.retention,
    }),
    // Filters for real: a toolbar whose chips move without moving the list is
    // worse than no harness at all — it looks like it works. See fake-page.ts
    // for which axes are replicated and what that costs.
    listDetectionPage: async ({ filter }) => fakePage(s, filter),
    // A real detail, not null: with null the drawer renders its "no longer
    // available" state and every block below it — including the collapsible —
    // never mounts, so the panel could not be reviewed or captured at all.
    detectionDetail: async (id) => {
      const row = s.rows.find((r) => r.id === id);
      if (row === undefined) return null;
      // A protocol tripwire's panel has to show what the proxy would really
      // write: its own findings, and for the response-side one an enrichment
      // with no arguments. The generic detail below would dress it as a
      // credential leak.
      if (row.category === 'protocol_tripwire') {
        const enrichment = row.type === 'mcp.detection_enrichment';
        return {
          id: row.id,
          ts: row.ts,
          session: '01M39D8KVX36DX7G2V353BDGPF',
          mcp: row.mcp,
          type: row.type,
          rpcId: 42,
          direction: 'server_to_client',
          category: row.category,
          severity: row.severity,
          source: row.source,
          findings: enrichment
            ? [{ type: 'input_required', location: 'result' }]
            : [{ type: 'server_request', location: 'method' }],
          ...(row.method !== undefined ? { method: row.method } : {}),
          ...(enrichment ? {} : { argumentsJson: JSON.stringify({ messages: [], maxTokens: 400 }, null, 2) }),
        };
      }
      return {
        id: row.id,
        ts: row.ts,
        session: '01M39D8KVX36DX7G2V353BDGPF',
        mcp: row.mcp,
        type: 'mcp.request',
        rpcId: 42,
        direction: 'client_to_server',
        category: row.category,
        severity: row.severity,
        source: row.source,
        findings: [
          { type: 'credential_like', location: 'arguments.token' },
          { type: 'credential_like', location: 'arguments.token' },
          { type: 'email_address', location: 'arguments.to' },
        ],
        ...(row.method !== undefined ? { method: row.method } : {}),
        ...(row.toolName !== undefined ? { toolName: row.toolName } : {}),
        argumentsJson: JSON.stringify(
          { query: row.argsSummary ?? 'quarterly report', limit: 20, includeArchived: false },
          null,
          2,
        ),
        overheadUs: 1180,
      };
    },
    exportAudit: never,
    retentionStatus: async () => ({
      config: { purgeMode: 'never', sizeWarnBytes: s.retention?.sizeWarnBytes ?? 1_000_000_000 },
      size:
        s.retention === null
          ? null
          : {
              totalBytes: s.retention.totalBytes,
              fileCount: s.rows.length,
              computedAtTs: '2026-09-24T12:00:00.000Z',
            },
      lastPurge: null,
    }),
    retentionSetMode: never,
    retentionEstimate: async () => 0,
    configStatus: async () => statusFor(s.entries),
    configInstall: never,
    configUninstall: never,
    configAddRemote: never,
    configRemoveRemote: never,
    configConnect: never,
    configIsConnected: async () => ({ ok: true, connected: true }),
    configHasCredentials: async () => true,
    configHasClient: async () => false,
    configSeedClient: never,
    configToolCount: async (name) => ({ count: name === 'notion' ? 19 : 7, ts: '2026-09-24T10:00:00.000Z' }),
    cchookStatus: async () => ({
      installed: true,
      hookRegistered: s.hookVanishedTs === null,
      pendingSpool: 0,
      pendingNotice: s.hookVanishedTs === null ? null : { ts: s.hookVanishedTs },
      lastCycle: null,
      unreadableTotal: 0,
      lastSessionStartTs: null,
    }),
    cchookInstall: never,
    cchookUninstall: never,
    cchookDismissVanished: async () => undefined,
    validateHealth: async () => ({
      status: 'healthy',
      checks: [],
      checkedAt: '2026-09-24T12:00:00.000Z',
    }),
    repairWraps: never,
    runSelfTest: never,
    openAuditFolder: async () => undefined,
    appVersion: async () => '0.0.0-harness',
    baselineHistory: baselineFor,
    connectorChanges: async (mcp) =>
      mcp === undefined ? (s.changes ?? []) : (s.changes ?? []).filter((c) => c.mcp === mcp),
    // A review marker has nowhere to go here, so the write is a no-op and what
    // you see is the component's own re-read of the same fixture.
    setReviewStatus: async () => undefined,
    exportChanges: async (ids) => ({ ok: true, count: ids.length, path: '/tmp/harness-changes.json' }),
    openAtLogin: async () => false,
    setOpenAtLogin: async () => false,
    // Deliberately inert rather than window.open: the harness must not navigate
    // anywhere, and CSP would block it regardless.
    openExternalUrl: async () => undefined,
  };
}
