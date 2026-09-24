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
import { pageFor, statusFor, type Scenario } from './fixtures.js';

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
    listDetectionPage: async () => pageFor(s),
    detectionDetail: async () => null,
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
    openAtLogin: async () => false,
    setOpenAtLogin: async () => false,
    // Deliberately inert rather than window.open: the harness must not navigate
    // anywhere, and CSP would block it regardless.
    openExternalUrl: async () => undefined,
  };
}
