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
});

describe('buildTrayMenuTemplate with counts', () => {
  it('flagged item leads, then Open · separator · Quit', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen, { flagged24h: 3, critical24h: 1 });
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      '3 flagged (24h)',
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
    expect(tpl[0]?.click).toBe(onOpen);
  });
});
