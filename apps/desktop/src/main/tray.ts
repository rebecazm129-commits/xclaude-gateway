import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnrichableEvent } from '../shared/types.js';

// Module-scope ref: keep the Tray alive. A local would be GC'd and the icon
// would vanish (classic Electron bug). Exposed via getTray() so Pieza 2c can
// call setTitle(<flagged count>) without re-plumbing.
let tray: Tray | null = null;
// The "open" action, captured at createTray() so updateTrayCounts() can rebuild
// the menu with the same click handler without re-plumbing it through callers.
let onOpenAction: (() => void) | null = null;

export function getTray(): Tray | null {
  return tray;
}

export interface TrayCounts {
  flagged24h: number;
  critical24h: number;
}

// Pure: counts mcp.request detections in the last 24h. flagged = any non-allowed
// category; critical = severity 'critical' (independent counters — a critical
// event is also flagged). Fields read verbatim from readDetections' output
// (DetectionEvent.ts / detection.category / detection.severity).
export function computeTrayCounts(events: readonly EnrichableEvent[], nowMs: number): TrayCounts {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  let flagged24h = 0;
  let critical24h = 0;
  for (const e of events) {
    if (e.type !== 'mcp.request') continue;
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (e.detection.category !== 'tool_call_allowed') flagged24h++;
    if (e.detection.severity === 'critical') critical24h++;
  }
  return { flagged24h, critical24h };
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

// Pure menu template (click handlers injected). When `counts` is given, an
// "N flagged (24h)" item leads the menu (same open action); without it the menu
// is identical to before. Extracted so it's unit-testable.
export function buildTrayMenuTemplate(onOpen: () => void, counts?: TrayCounts): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (counts) {
    template.push({ label: `${counts.flagged24h} flagged (24h)`, click: onOpen });
  }
  template.push(
    { label: 'Open xCLAUDE Gateway', click: onOpen },
    { type: 'separator' },
    { label: 'Quit xCLAUDE Gateway', click: () => app.quit() },
  );
  return template;
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
  onOpenAction = onOpen;
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

// Updates the live Tray from fresh counts: no menu-bar title (the tray shows
// only the logo, never a number), and a rebuilt context menu
// with the "N flagged (24h)" line. No-op until createTray() has run.
export function updateTrayCounts(counts: TrayCounts): void {
  if (!tray || !onOpenAction) return;
  tray.setTitle('');
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(onOpenAction, counts)));
}
