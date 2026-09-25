import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS, type EnrichableEvent } from '../shared/types.js';
import { countsAsFlagged } from '../shared/flagged.js';

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
  const cutoff = nowMs - DAY_MS;
  let flagged24h = 0;
  let critical24h = 0;
  for (const e of events) {
    // mcp.request carries its detection inline; a response-content detection
    // (Slice 1) arrives as a server_to_client mcp.detection_enrichment. Count
    // ONLY that direction so NER request-enrichments (client_to_server) keep
    // their existing counting behavior untouched.
    const counts =
      e.type === 'mcp.request' ||
      (e.type === 'mcp.detection_enrichment' && e.direction === 'server_to_client');
    if (!counts) continue;
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (countsAsFlagged(e.detection.category)) flagged24h++;
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

export interface TrayMenuState {
  counts?: TrayCounts;
  /** How many connectors currently need re-login (audit.authAlerts.length).
   *  0 or undefined hides the line entirely. */
  authAlertCount?: number;
  /** Current OS value, read fresh by the caller — never a cached boolean. */
  openAtLogin?: boolean;
  /** Toggle handler; omitted in contexts with no login-item support. */
  onToggleOpenAtLogin?: (next: boolean) => void;
}

// Pure menu template (click handlers injected). Extracted so it's unit-testable.
//
// Four groups, separated:
//   1. status  — what is wrong or worth a look (re-login first, then flagged)
//   2. setting — open at login
//   3. action  — open the window
//   4. quit
// The status group leads because the menu is the one surface that reaches the
// user with the window closed, and re-login leads within it: it is the only
// line that means something is BROKEN.
export function buildTrayMenuTemplate(
  onOpen: () => void,
  state: TrayMenuState = {},
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  const alerts = state.authAlertCount ?? 0;
  if (alerts > 0) {
    template.push({
      label: alerts === 1 ? '1 connector needs re-login' : `${alerts} connectors need re-login`,
      click: onOpen,
    });
  }
  if (state.counts) {
    template.push({ label: `${state.counts.flagged24h} flagged (24h)`, click: onOpen });
  }
  // Only separate when the status group actually produced something, so a menu
  // with nothing to report never opens on a stray rule.
  if (template.length > 0) template.push({ type: 'separator' });

  if (state.onToggleOpenAtLogin) {
    const current = state.openAtLogin ?? false;
    const toggle = state.onToggleOpenAtLogin;
    template.push(
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: current,
        click: () => toggle(!current),
      },
      { type: 'separator' },
    );
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

// Updates the live Tray: no menu-bar title (the tray shows only the logo, never
// a number), and a rebuilt context menu. No-op until createTray() has run.
//
// A macOS context menu set with setContextMenu is STATIC — there is no
// "about to open" hook to refresh it from, so `openAtLogin` is re-read from the
// OS on every rebuild (the 60s tray tick, and immediately after any toggle)
// rather than cached in a module variable. See the note in index.ts.
export function updateTrayMenu(state: TrayMenuState): void {
  if (!tray || !onOpenAction) return;
  tray.setTitle('');
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(onOpenAction, state)));
}
