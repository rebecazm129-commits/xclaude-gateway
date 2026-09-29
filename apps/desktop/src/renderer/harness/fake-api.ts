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

import type { CchookHooksCheck } from '../../shared/types.js';
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
  // "Update hooks" works for real in the harness: the next status is up to
  // date, so the notice can be captured before and after the click.
  let hookCheck: CchookHooksCheck = s.hookCheck ?? { state: 'up_to_date' };
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
      // A Claude Code elicitation: the whitelist view the reader derives from
      // the trail, and the action from its ElicitationResult.
      if (row.method === 'elicitation/create') {
        const secret = row.severity === 'high';
        return {
          id: row.id,
          ts: row.ts,
          session: '01M39D8KVX36DX7G2V353BDGPF',
          mcp: row.mcp,
          type: 'mcp.request',
          rpcId: null,
          direction: 'server_to_client',
          category: row.category,
          severity: row.severity,
          source: row.source,
          findings: [{ type: 'server_request', location: 'elicitation', ...(secret ? { rule: 'secret_field' } : {}) }],
          method: row.method,
          elicitation: secret
            ? {
                server: row.mcp,
                mode: 'form',
                message: 'Sign in to Acme Cloud to continue the deployment. Having trouble? Visit https://acme-cloud.example/help',
                fields: [
                  { name: 'username', type: 'string', title: 'Username', required: true },
                  { name: 'password', type: 'string', title: 'Password', required: true },
                ],
              }
            : {
                server: row.mcp,
                mode: 'form',
                message: 'Confirm the export settings',
                fields: [
                  { name: 'format', type: 'string', title: 'Format', required: true },
                  { name: 'include_archived', type: 'boolean', title: 'Include archived', required: false },
                ],
              },
          ...(row.elicitationAction !== undefined ? { elicitationAction: row.elicitationAction } : {}),
        };
      }
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
      // audit_trail_modification: the finding the detector writes (subtype and
      // tool) and the call it came from.
      if (row.category === 'audit_trail_modification') {
        const deletes = row.toolName === 'Bash';
        const trail = '/Users/you/Library/Application Support/xCLAUDE Gateway/wrappers';
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
          findings: deletes
            ? [{ type: 'delete', location: 'Bash', rule: 'rm' }]
            : [{ type: 'write', location: 'Edit' }],
          ...(row.method !== undefined ? { method: row.method } : {}),
          ...(row.toolName !== undefined ? { toolName: row.toolName } : {}),
          argumentsJson: JSON.stringify(
            deletes
              ? { command: `rm "${trail}/01M3DG5Y000000000000000000.jsonl"`, description: 'Remove old trail file' }
              : { file_path: `${trail}/app-events.jsonl`, old_string: '"to":"unreviewed"', new_string: '"to":"reviewed"' },
            null,
            2,
          ),
          overheadUs: 0,
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
      hookCheck,
      claudeCodeVersion: '2.1.283',
      elicitationSupported: true,
      elicitationMinVersion: '2.1.76',
      settingsBackupDir: '~/Library/Application Support/xCLAUDE Gateway/backups/claude-settings',
      settingsManaged: s.settingsManaged ?? null,
      lastCycle: null,
      unreadableTotal: 0,
      lastSessionStartTs: null,
    }),
    cchookInstall: never,
    cchookNotNow: async () => undefined,
    cchookUpdate: async () => {
      hookCheck = { state: 'up_to_date' };
      return {
        ok: true,
        outcome: 'wrote',
        settingsPath: '/Users/you/.claude/settings.json',
        backupPath: '~/Library/Application Support/xCLAUDE Gateway/backups/claude-settings/settings-20260929T101500000Z.json',
      };
    },
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
