import { app, BrowserWindow, Notification, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSymlink, type SelfTestReport } from '@xcg/shared';
import {
  CLAUDE_DESKTOP_CONFIG_PATH,
  STABLE_XCG_PROXY_PATH,
} from '@xcg/shared/config';

import {
  resolveXcgPathFromMain,
  resolveXcgTargetPathFromMain,
  runConfigAddRemote,
  runConfigInstall,
  runConfigIsConnected,
  runConfigRemoveRemote,
  runConfigStatus,
  runConfigUninstall,
} from './config-handlers.js';
import { runValidateHealth, runRepairWraps } from './health-handlers.js';
import { readLatestToolCount } from './detection-reader.js';
import type {
  DetectionCursor,
  DetectionDetail,
  DetectionFilter,
  DetectionListResult,
  DetectionPageResult,
  RetentionConfig,
  RetentionSetModeResult,
  RetentionSizeSnapshot,
  RetentionStatus,
} from '../shared/types.js';
import {
  BASE_DIR,
  WRAPPERS_DIR,
  estimatePurgable,
  estimatePurgableForMode,
  isPurgeMode,
  readLastPurgeMarker,
  readRetentionConfig,
  runSweep,
  writeRetentionConfig,
} from './retention.js';
import { createAuditStore } from './audit-store.js';
import { spawnWrapper, readDetectionsFromAudit, resolveNpxPath } from './selftest-runner.js';
import { runSelfTest } from './selftest-handler.js';
import { runConfigConnect } from './connect-handler.js';
import { runLoginProcess } from './login-runner.js';
import { hasStoredCredentials, hasStoredClient } from '@xcg/proxy/credentials';
import { createTray, computeTrayCounts, updateTrayCounts } from './tray.js';
import { computeReloginTransitions } from './relogin-notify.js';
import { isAllowedNavigation } from './navigation-guard.js';
import { writeConnectorRecovered } from './recovery-writer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f0ebe1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Defense-in-depth: pin Electron's secure defaults explicitly rather
      // than relying on them. The renderer runs untrusted MCP output, so it
      // must stay isolated from Node and the preload's context.
      contextIsolation: true,
      nodeIntegration: false,
      // macOS 26 (Tahoe): the native context menu queries the spellcheck
      // service, and constructing that native menu crashes the browser process
      // (EXC_BAD_ACCESS in CrBrowserMain). Disabling spellcheck removes the
      // query path; suppressing the menu itself is done in the renderer.
      spellcheck: false,
    },
  });

  // Defense-in-depth: the renderer never originates navigation or new windows.
  // Deny window.open outright, and block any will-navigate that isn't the local
  // app (file://) or the dev server. External links go via shell.openExternal.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, process.env['ELECTRON_RENDERER_URL'])) {
      event.preventDefault();
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Tray "open" action: focus the existing window or create one. Kept here so
// createWindow stays local to index.ts (tray.ts receives this as a callback).
function openWindow(): void {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  } else {
    createWindow();
  }
}

// Retention banner info from the in-memory caches (populated by the sweep). No
// disk cost. Shared by detection:list (back-compat) and detection:page.
function retentionBanner(): DetectionListResult['retention'] {
  return retentionSizeCache !== null && retentionConfigCache !== null
    ? {
        totalBytes: retentionSizeCache.totalBytes,
        sizeWarnBytes: retentionConfigCache.sizeWarnBytes,
      }
    : null;
}

// Back-compat: the full unpaginated list. Still used by Setup and
// ConnectorInspector (not yet migrated to detection:page).
ipcMain.handle('detection:list', async (): Promise<DetectionListResult> => {
  const audit = await auditStore.get();
  updateTrayCounts(computeTrayCounts(audit.events, Date.now()));
  return { ...audit, retention: retentionBanner() };
});

// Paginated, server-filtered slim page for the Detections view.
ipcMain.handle(
  'detection:page',
  async (
    _event,
    params: { filter: DetectionFilter; limit: number; cursor: DetectionCursor | null },
  ): Promise<DetectionPageResult> => {
    const page = await auditStore.getPage(params);
    // Tray counts over the FULL store set, independent of filter/limit (the
    // second get() is coalesced with getPage's internal one — no extra disk).
    const full = await auditStore.get();
    updateTrayCounts(computeTrayCounts(full.events, Date.now()));
    return { ...page, retention: retentionBanner() };
  },
);

// Heavy detail for one event, fetched lazily when the DetailDrawer opens.
ipcMain.handle(
  'detection:detail',
  async (_event, params: { id: string }): Promise<DetectionDetail | null> => {
    return auditStore.getDetail(params.id);
  },
);

// Retention status for the Settings drawer. Reads config + last purge on
// demand (only when Settings opens); size comes from the cached snapshot.
ipcMain.handle('retention:status', async (): Promise<RetentionStatus> => {
  const config = await readRetentionConfig(BASE_DIR);
  retentionConfigCache = config;
  const lastPurge = await readLastPurgeMarker(WRAPPERS_DIR);
  return { config, size: retentionSizeCache, lastPurge };
});

// Change the purge mode. Persists via writeAtomic and returns the estimated
// number of files the NEXT sweep would purge (by ULID decodeTime; nothing is
// deleted here — the purge is deferred to the daily sweep).
ipcMain.handle(
  'retention:set-mode',
  async (_event, params: { mode: unknown }): Promise<RetentionSetModeResult> => {
    const current = retentionConfigCache ?? (await readRetentionConfig(BASE_DIR));
    const mode = params?.mode;
    if (!isPurgeMode(mode)) {
      return { ok: false, config: current, purgableEstimate: 0 };
    }
    const next: RetentionConfig = { ...current, purgeMode: mode };
    const wr = writeRetentionConfig(next, BASE_DIR);
    if (!wr.ok) {
      return { ok: false, config: current, purgableEstimate: 0 };
    }
    retentionConfigCache = next;
    const purgableEstimate = await estimatePurgable(WRAPPERS_DIR, mode, Date.now());
    return { ok: true, config: next, purgableEstimate };
  },
);

// Read-only preview: how many session files the NEXT sweep would purge at
// `mode`. Persists NOTHING (unlike retention:set-mode) — used to show the impact
// before the user confirms a change.
ipcMain.handle(
  'retention:estimate',
  async (_event, params: { mode: unknown }): Promise<number> => {
    return estimatePurgableForMode(WRAPPERS_DIR, params?.mode, Date.now());
  },
);

ipcMain.handle('config:status', () => {
  return runConfigStatus({
    configPath: CLAUDE_DESKTOP_CONFIG_PATH,
    xcgPath: resolveXcgPathFromMain(),
  });
});

ipcMain.handle('config:install', (_event, mode: 'dry-run' | 'yes', only?: string) => {
  return runConfigInstall(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    mode,
    only,
  );
});

ipcMain.handle('config:uninstall', (_event, mode: 'dry-run' | 'yes') => {
  return runConfigUninstall(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    mode,
  );
});

ipcMain.handle('config:add-remote', (_event, params: { name: string; url: string }) => {
  return runConfigAddRemote(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    params,
  );
});

ipcMain.handle('config:remove-remote', (_event, params: { name: string }) => {
  return runConfigRemoveRemote(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    params,
  );
});

ipcMain.handle('config:connect', async (_event, params: { name: string; url: string; scope?: string }) => {
  const result = await runConfigConnect(
    { login: runLoginProcess },
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
      proxyBinPath: resolveXcgTargetPathFromMain(),
      name: params.name,
      url: params.url,
      scope: params.scope,
      timeoutMs: 360_000,
    },
  );
  // A successful reconnect re-authorized a connector that may still carry a
  // stale re-login alert (derived from a past oauth_failed with no later
  // signal). Emit a recovery marker so readAudit clears it on the next 2s
  // poll, instead of only after a Claude Desktop restart. Fresh connects
  // (reconnected === false) can't have a prior alert, so they're skipped.
  if (result.ok && result.reconnected) {
    writeConnectorRecovered(params.name);
  }
  return result;
});

ipcMain.handle('config:is-connected', (_event, params: { name: string }) => {
  return runConfigIsConnected(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    { name: params.name },
  );
});

// Keychain-only query (no config read): does this connector have a stored OAuth
// token? Returns a plain boolean; a real Keychain error rejects (the renderer
// degrades the Auth row to "—"). Mirrors the config:is-connected shape.
ipcMain.handle('config:has-credentials', (_event, params: { name: string }) => {
  return hasStoredCredentials(params.name);
});

ipcMain.handle('config:has-client', (_event, params: { name: string }) => {
  return hasStoredClient(params.name);
});

// Latest tool inventory size for a connector, derived read-only from the audit
// JSONL (the proxy already records tools/list responses). null if unknown.
ipcMain.handle('config:tool-count', (_event, params: { name: string }) => {
  return readLatestToolCount(params.name);
});

ipcMain.handle('system:health', () => {
  return runValidateHealth({
    configPath: CLAUDE_DESKTOP_CONFIG_PATH,
    xcgTargetPath: resolveXcgTargetPathFromMain(),
  });
});

ipcMain.handle('system:repair-wraps', () => {
  return runRepairWraps({
    configPath: CLAUDE_DESKTOP_CONFIG_PATH,
    xcgTargetPath: resolveXcgTargetPathFromMain(),
  });
});

ipcMain.handle('system:self-test:run', async (): Promise<SelfTestReport> => {
  const npxPath = resolveNpxPath(CLAUDE_DESKTOP_CONFIG_PATH);
  if (npxPath === null) {
    const ts = new Date().toISOString();
    return {
      runId: randomUUID(),
      startedAt: ts,
      finishedAt: ts,
      outcome: {
        kind: 'spawn_failed',
        reason: 'npx not found in PATH, config, or known locations',
      },
      entries: [],
      wrapperSession: null,
      auditFile: null,
    };
  }
  return runSelfTest(
    {
      launcher: spawnWrapper,
      reader: readDetectionsFromAudit,
      runId: () => randomUUID(),
      now: () => new Date().toISOString(),
    },
    {
      proxyBinPath: resolveXcgTargetPathFromMain(),
      npxPath,
      serverPackage: '@modelcontextprotocol/server-everything',
      discoveryTimeoutMs: 5000,
      readbackTimeoutMs: 10000,
    },
  );
});

// Milestone 4 Phase 3b: ensure a stable symlink in
// ~/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy that points
// at the launcher inside the running .app. The wrap plan written into
// claude_desktop_config.json (F4) will reference this path, not the .app
// absolute path, so moving the app does not break Claude Desktop.
// In dev we skip: process.resourcesPath is not the wrapper layout and the
// developer does not need a global symlink.
function bootstrapStableSymlink(): void {
  if (!app.isPackaged) {
    console.log('[xcg] dev mode: skip stable symlink bootstrap');
    return;
  }
  const target = join(process.resourcesPath, 'proxy', 'bin', 'xcg-proxy');
  const link = STABLE_XCG_PROXY_PATH;
  const r = ensureSymlink(target, link);
  if (r.ok) {
    console.log(`[xcg] stable symlink ${r.status}: ${link} -> ${target}`);
  } else {
    // Degrade graceful: the app still works for auditing. The Milestone 4
    // config wrap (F4) will need this path; if it is missing, the user can
    // re-run xcg-config install. We never bring down the app for a symlink.
    console.error(
      `[xcg] stable symlink FAILED (${r.error.kind}): ${r.error.detail ?? ''}`,
    );
  }
}

const TRAY_REFRESH_MS = 60_000;
let trayRefreshHandle: NodeJS.Timeout | null = null;

// Retention: a daily sweep in the MAIN process (never the 2s poll). Handle +
// caches are module state, same pattern as trayRefreshHandle. The size/config
// caches feed the detection:list piggyback and the retention:status handler.
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
let retentionSweepHandle: NodeJS.Timeout | null = null;
let retentionSizeCache: RetentionSizeSnapshot | null = null;
let retentionConfigCache: RetentionConfig | null = null;

// Single source of truth for the audit trail: detection:list, the tray loop and
// the retention sweep all read through this incremental cache.
const auditStore = createAuditStore(WRAPPERS_DIR);

async function runRetentionSweep(): Promise<void> {
  try {
    const config = await readRetentionConfig(BASE_DIR);
    retentionConfigCache = config;
    const outcome = await runSweep(WRAPPERS_DIR, config, Date.now());
    retentionSizeCache = outcome.size;
    // Drop purged sessions from the incremental cache right away (they're also
    // gone from readdir, but this bypasses the refresh window).
    if (outcome.purgedFiles.length > 0) {
      auditStore.invalidate(outcome.purgedFiles);
    }
    if (outcome.purged) {
      console.log(
        `[xcg] retention purge removed ${outcome.purged.filesPurged} session file(s) ` +
          `(${outcome.purged.purgedFromTs} → ${outcome.purged.purgedUntilTs})`,
      );
    }
  } catch (err) {
    console.error('[xcg] retention sweep failed:', err);
  }
}
// Re-login notification dedupe (slice C): same module-state pattern as
// trayRefreshHandle. notifiedRelogin = connectors currently accounted for as
// alerting; reloginSeeded = whether the first evaluation has run (the first
// pass seeds these without notifying).
let notifiedRelogin = new Set<string>();
let reloginSeeded = false;

void app.whenReady().then(() => {
  bootstrapStableSymlink();
  createWindow();
  createTray(openWindow);
  // First recurring loop in the MAIN process: a 60s backstop so the tray count
  // stays fresh even with no renderer polling (all windows closed). KNOWN loose
  // end — this and the renderer's usePolledDetections (2s) are candidates to
  // collapse into a single source-of-truth poll later.
  trayRefreshHandle = setInterval(() => {
    void auditStore.get().then((audit) => {
      updateTrayCounts(computeTrayCounts(audit.events, Date.now()));
      // Re-login transitions: notify once when a connector enters the alert set.
      const currentMcps = new Set(audit.authAlerts.map((a) => a.mcp));
      const { toNotify, nextNotified, nextSeeded } = computeReloginTransitions(
        notifiedRelogin,
        currentMcps,
        reloginSeeded,
      );
      notifiedRelogin = nextNotified;
      reloginSeeded = nextSeeded;
      if (Notification.isSupported()) {
        for (const mcp of toNotify) {
          const n = new Notification({
            title: `${mcp} needs re-login`,
            body: 'Authorization expired. Reconnect it in xCLAUDE Gateway and restart Claude Desktop.',
          });
          n.on('click', () => openWindow());
          n.show();
        }
      }
    });
  }, TRAY_REFRESH_MS);
  // Retention: one deferred sweep after the first audit read, then a daily
  // interval. Never runs on the renderer's 2s poll. mode 'never' (default) is a
  // no-op for deletion — the pass only refreshes the cached directory size.
  void auditStore
    .get()
    .then(() => runRetentionSweep())
    .catch((err) => console.error('[xcg] initial retention sweep failed:', err));
  retentionSweepHandle = setInterval(() => {
    void runRetentionSweep();
  }, RETENTION_SWEEP_MS);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (trayRefreshHandle) clearInterval(trayRefreshHandle);
  if (retentionSweepHandle) clearInterval(retentionSweepHandle);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('system:open-audit-folder', async (): Promise<void> => {
  const dir = join(homedir(), 'Library', 'Application Support', 'xCLAUDE Gateway', 'wrappers');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore mkdir errors; openPath will fail visibly if dir is unreachable
  }
  const result = await shell.openPath(dir);
  if (result !== '') {
    console.error('openPath failed:', result);
  }
});

ipcMain.handle('system:open-external', async (_event, url: string): Promise<void> => {
  // Only ever hand http(s) URLs to the system browser — never file:, etc.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  await shell.openExternal(parsed.toString());
});
