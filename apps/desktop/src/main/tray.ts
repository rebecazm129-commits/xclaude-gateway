import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-scope ref: keep the Tray alive. A local would be GC'd and the icon
// would vanish (classic Electron bug). Exposed via getTray() so Pieza 2c can
// call setTitle(<flagged count>) without re-plumbing.
let tray: Tray | null = null;

export function getTray(): Tray | null {
  return tray;
}

// Resolves the 22px template PNG; macOS auto-picks @2x/@3x siblings in the same
// dir. dev: <repo>/build/ (4 levels up from out/main — same pattern as the proxy
// path resolution); packaged: <Resources>/tray/ (electron-builder extraResources).
// Pure: takes the runtime facts as args so it's unit-testable without electron.
export function resolveTrayIconPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  mainDirUrl: string;
}): string {
  if (opts.isPackaged) {
    return join(opts.resourcesPath, 'tray', 'xclaude-tray-icon.png');
  }
  const here = fileURLToPath(new URL('.', opts.mainDirUrl));
  return join(here, '..', '..', '..', '..', 'build', 'xclaude-tray-icon.png');
}

// Pure menu template (click handlers injected). Extracted so it's unit-testable
// and so Pieza 2c can splice a "N flagged (24h)" item before the separator.
export function buildTrayMenuTemplate(onOpen: () => void): MenuItemConstructorOptions[] {
  return [
    { label: 'Open xCLAUDE Gateway', click: onOpen },
    { type: 'separator' },
    { label: 'Quit xCLAUDE Gateway', click: () => app.quit() },
  ];
}

// Creates the menu-bar Tray. `onOpen` (show/focus window) is owned by index.ts so
// createWindow stays there — no circular import. Creates at most one Tray.
//
// Interaction model: with a context menu set, a left click on the macOS menu-bar
// icon opens the menu (the 'click' event does NOT fire), so there is no separate
// click handler — "Open xCLAUDE Gateway" is the first menu item and carries the
// open action.
export function createTray(onOpen: () => void): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(
    resolveTrayIconPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDirUrl: import.meta.url,
    }),
  );
  icon.setTemplateImage(true); // black+alpha PNGs → macOS recolors for light/dark
  tray = new Tray(icon);
  tray.setToolTip('xCLAUDE Gateway');
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(onOpen)));
}
