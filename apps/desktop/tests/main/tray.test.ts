import { describe, it, expect, vi } from 'vitest';

import { resolveTrayIconPath, buildTrayMenuTemplate, computeTrayCounts } from '../../src/main/tray.js';
import type { EnrichableEvent } from '../../src/shared/types.js';

describe('resolveTrayIconPath', () => {
  it('packaged → <resourcesPath>/tray/xclaude-tray-icon.png', () => {
    expect(
      resolveTrayIconPath({
        isPackaged: true,
        resourcesPath: '/App/Contents/Resources',
        mainDirUrl: 'file:///anything/out/main/index.js',
      }),
    ).toBe('/App/Contents/Resources/tray/xclaude-tray-icon.png');
  });

  it('dev → <repo>/build/xclaude-tray-icon.png (4 levels up from out/main)', () => {
    expect(
      resolveTrayIconPath({
        isPackaged: false,
        resourcesPath: '/ignored',
        mainDirUrl: 'file:///Users/x/code/xclaude-gateway/apps/desktop/out/main/index.js',
      }),
    ).toBe('/Users/x/code/xclaude-gateway/build/xclaude-tray-icon.png');
  });
});

describe('buildTrayMenuTemplate', () => {
  it('is Open (= onOpen) · separator · Quit', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen);
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
    expect(tpl[0]?.click).toBe(onOpen);
  });
});

// Minimal mcp.request fixture (only the fields computeTrayCounts reads).
function reqEvent(ts: string, category: string, severity: string): EnrichableEvent {
  return {
    id: ts, ts, session: 's', mcp: 'm', type: 'mcp.request', method: 'tools/call',
    rpcId: 1, direction: 'client_to_server',
    detection: { category, severity, findings: [] },
  } as unknown as EnrichableEvent;
}

// Minimal mcp.detection_enrichment fixture: Slice 1 response-content detections
// arrive server_to_client; NER request-enrichments arrive client_to_server.
function enrEvent(
  ts: string,
  category: string,
  severity: string,
  direction: 'client_to_server' | 'server_to_client',
): EnrichableEvent {
  return {
    id: ts + direction, ts, session: 's', mcp: 'm', type: 'mcp.detection_enrichment',
    rpcId: 1, direction,
    detection: { category, severity, findings: [] },
  } as unknown as EnrichableEvent;
}

describe('computeTrayCounts', () => {
  const NOW = Date.parse('2026-06-11T12:00:00Z');
  const within = new Date(NOW - 60 * 60 * 1000).toISOString();       // 1h ago
  const outside = new Date(NOW - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

  it('counts flagged + critical within 24h', () => {
    const events = [
      reqEvent(within, 'data_export_warning', 'high'),  // flagged, not critical
      reqEvent(within, 'pii_detected', 'critical'),     // flagged + critical
      reqEvent(within, 'tool_call_allowed', 'low'),     // neither
    ];
    expect(computeTrayCounts(events, NOW)).toEqual({ flagged24h: 2, critical24h: 1 });
  });

  it('excludes events older than 24h', () => {
    expect(computeTrayCounts([reqEvent(outside, 'pii_detected', 'critical')], NOW))
      .toEqual({ flagged24h: 0, critical24h: 0 });
  });

  it('empty → zeros', () => {
    expect(computeTrayCounts([], NOW)).toEqual({ flagged24h: 0, critical24h: 0 });
  });

  it('counts server_to_client enrichment (Slice 1), ignores client_to_server (NER)', () => {
    const events = [
      enrEvent(within, 'credential_detected', 'critical', 'server_to_client'), // counts
      enrEvent(within, 'pii_detected', 'medium', 'client_to_server'),          // NER: ignored
    ];
    expect(computeTrayCounts(events, NOW)).toEqual({ flagged24h: 1, critical24h: 1 });
  });
});

describe('buildTrayMenuTemplate with counts', () => {
  it('flagged item leads, then Open · separator · Quit', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen, { counts: { flagged24h: 3, critical24h: 1 } });
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      '3 flagged (24h)',
      'separator',
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
    expect(tpl[0]?.click).toBe(onOpen);
  });
});

// The menu is the only surface that reaches the user with the window closed and
// notifications missed — the gap the 08-15/09 stripe outage fell through.
describe('buildTrayMenuTemplate — re-login line', () => {
  it('absent when there are no auth alerts', () => {
    const tpl = buildTrayMenuTemplate(vi.fn(), { authAlertCount: 0 });
    // Nothing to report → no leading separator either.
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
  });

  it('singular for one connector, and it leads the menu', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen, { authAlertCount: 1 });
    expect(tpl[0]?.label).toBe('1 connector needs re-login');
    expect(tpl[0]?.click).toBe(onOpen);
  });

  it('plural for several, and it still leads when counts are present too', () => {
    const tpl = buildTrayMenuTemplate(vi.fn(), {
      authAlertCount: 3,
      counts: { flagged24h: 7, critical24h: 0 },
    });
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      '3 connectors need re-login',
      '7 flagged (24h)',
      'separator',
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
  });

  it('clicking it opens the window', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen, { authAlertCount: 2 });
    (tpl[0]?.click as () => void)();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('buildTrayMenuTemplate — Open at login', () => {
  it('absent when no toggle handler is supplied', () => {
    const tpl = buildTrayMenuTemplate(vi.fn(), { openAtLogin: true });
    expect(tpl.map((i) => i.label)).not.toContain('Open at login');
  });

  it('checkbox reflects the value passed in, not a cached one', () => {
    const on = buildTrayMenuTemplate(vi.fn(), { openAtLogin: true, onToggleOpenAtLogin: vi.fn() });
    const off = buildTrayMenuTemplate(vi.fn(), { openAtLogin: false, onToggleOpenAtLogin: vi.fn() });
    const item = (tpl: ReturnType<typeof buildTrayMenuTemplate>) =>
      tpl.find((i) => i.label === 'Open at login');
    expect(item(on)?.type).toBe('checkbox');
    expect(item(on)?.checked).toBe(true);
    expect(item(off)?.checked).toBe(false);
  });

  it('clicking toggles to the opposite of the value shown', () => {
    const toggle = vi.fn();
    const tpl = buildTrayMenuTemplate(vi.fn(), { openAtLogin: false, onToggleOpenAtLogin: toggle });
    const item = tpl.find((i) => i.label === 'Open at login');
    (item?.click as () => void)();
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it('an external change (OS) is reflected on the next rebuild', () => {
    // Mirrors how index.ts rebuilds: the value comes from a fresh OS read each
    // time, so flipping it outside the app shows up without any invalidation.
    const toggle = vi.fn();
    let osValue = false;
    const rebuild = () =>
      buildTrayMenuTemplate(vi.fn(), { openAtLogin: osValue, onToggleOpenAtLogin: toggle });
    expect(rebuild().find((i) => i.label === 'Open at login')?.checked).toBe(false);
    osValue = true; // e.g. the user enabled it in System Settings
    expect(rebuild().find((i) => i.label === 'Open at login')?.checked).toBe(true);
  });
});

describe('buildTrayMenuTemplate — grouping', () => {
  it('four separated groups: status · setting · open · quit', () => {
    const tpl = buildTrayMenuTemplate(vi.fn(), {
      authAlertCount: 1,
      counts: { flagged24h: 2, critical24h: 0 },
      openAtLogin: true,
      onToggleOpenAtLogin: vi.fn(),
    });
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      '1 connector needs re-login',
      '2 flagged (24h)',
      'separator',
      'Open at login',
      'separator',
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
  });

  it('never opens on a separator when there is nothing to report', () => {
    const tpl = buildTrayMenuTemplate(vi.fn(), {
      openAtLogin: false,
      onToggleOpenAtLogin: vi.fn(),
    });
    expect(tpl[0]?.type).not.toBe('separator');
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      'Open at login',
      'separator',
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
  });
});
