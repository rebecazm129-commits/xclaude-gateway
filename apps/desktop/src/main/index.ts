import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSymlink } from '@xcg/shared';
import { STABLE_XCG_PROXY_PATH } from '@xcg/shared/config';

import { readDetections } from './detection-reader.js';

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
