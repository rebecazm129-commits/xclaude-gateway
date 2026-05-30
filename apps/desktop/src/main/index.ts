import { app, BrowserWindow, ipcMain, shell } from 'electron';
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
  runConfigRemoveRemote,
  runConfigStatus,
  runConfigUninstall,
} from './config-handlers.js';
import { runValidateHealth, runRepairWraps } from './health-handlers.js';
import { readDetections } from './detection-reader.js';
import { spawnWrapper, readDetectionsFromAudit, resolveNpxPath } from './selftest-runner.js';
import { runSelfTest } from './selftest-handler.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle('detection:list', async () => {
  return readDetections();
});

ipcMain.handle('config:status', () => {
  return runConfigStatus({
    configPath: CLAUDE_DESKTOP_CONFIG_PATH,
    xcgPath: resolveXcgPathFromMain(),
  });
});

ipcMain.handle('config:install', (_event, mode: 'dry-run' | 'yes') => {
  return runConfigInstall(
    {
      configPath: CLAUDE_DESKTOP_CONFIG_PATH,
      xcgPath: resolveXcgPathFromMain(),
    },
    mode,
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

void app.whenReady().then(() => {
  bootstrapStableSymlink();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
