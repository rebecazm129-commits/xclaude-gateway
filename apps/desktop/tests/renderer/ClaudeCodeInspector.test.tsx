// @vitest-environment jsdom
// Component tests for ClaudeCodeInspector (F1.3c, source-axis parity F1.5):
// kv rows, the dot+Auditing status badge, the source-filtered Recent flagged
// list (counter and list share isClaudeCodeFlagged), the Open in Detections
// callback and the relative heartbeat.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  ClaudeCodeInspector,
  formatRelative,
  isClaudeCodeFlagged,
} from '../../src/renderer/components/ClaudeCodeInspector.js';
import type { CchookStatus, DetectionEvent, EnrichableEvent } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STATUS: CchookStatus = {
  installed: true,
  hookRegistered: true,
  pendingSpool: 3,
  unreadableTotal: 1,
  lastCycle: { processed: 5, skippedUnreadable: 1, deletedStale: 0, ts: '2026-07-16T09:00:00.000Z' },
  lastSessionStartTs: new Date(Date.now() - 5 * 60_000).toISOString(),
};

// A flagged mcp.request as the cchook ingester synthesizes it: source
// 'claude-code' on the line, mcp = real server for MCP tools ('claude-code'
// itself only for built-ins). Fresh ts so it sits inside the 7d window.
let seq = 0;
function ccEvent(over: Partial<DetectionEvent> = {}): DetectionEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    ts: new Date(Date.now() - seq * 60_000).toISOString(),
    session: 's1',
    mcp: 'notion',
    type: 'mcp.request',
    method: 'tools/call',
    rpcId: seq,
    direction: 'client_to_server',
    detection: { category: 'credential_detected', severity: 'high', findings: [] },
    source: 'claude-code',
    toolName: 'notion-update-page',
    ...over,
  };
}

function stubXcg(events: EnrichableEvent[] = [], extra: Record<string, unknown> = {}): void {
  vi.stubGlobal('xcg', {
    listDetections: vi.fn(async () => ({ events, authAlerts: [] })),
    ...extra,
  });
}

describe('isClaudeCodeFlagged — source axis', () => {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  it('counts hook-captured MCP calls (mcp = real server, source = claude-code)', () => {
    expect(isClaudeCodeFlagged(ccEvent({ mcp: 'notion' }), weekAgo)).toBe(true);
  });

  it('counts built-in tool calls (mcp = claude-code)', () => {
    expect(isClaudeCodeFlagged(ccEvent({ mcp: 'claude-code', toolName: 'Bash' }), weekAgo)).toBe(true);
  });

  it('excludes wrapper (gateway) events — no source field — whatever their mcp', () => {
    const wrapper = ccEvent();
    delete wrapper.source;
    expect(isClaudeCodeFlagged(wrapper, weekAgo)).toBe(false);
  });

  it('excludes tool_call_allowed, out-of-window and enrichment events', () => {
    expect(
      isClaudeCodeFlagged(
        ccEvent({ detection: { category: 'tool_call_allowed', severity: 'low', findings: [] } }),
        weekAgo,
      ),
    ).toBe(false);
    expect(
      isClaudeCodeFlagged(
        ccEvent({ ts: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() }),
        weekAgo,
      ),
    ).toBe(false);
    const enrichment: EnrichableEvent = {
      id: 'en-1',
      ts: new Date(now).toISOString(),
      session: 's1',
      mcp: 'notion',
      type: 'mcp.detection_enrichment',
      rpcId: 1,
      direction: 'client_to_server',
      detection: { category: 'pii_detected', severity: 'medium', findings: [] },
      source: 'claude-code',
    };
    expect(isClaudeCodeFlagged(enrichment, weekAgo)).toBe(false);
  });
});

describe('ClaudeCodeInspector', () => {
  it('renders the kv rows, the dot+Auditing badge and both scope notes', async () => {
    stubXcg([ccEvent(), ccEvent({ mcp: 'claude-code', toolName: 'Bash' })]);
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);
    expect(screen.getByText('claude-code')).toBeDefined();
    expect(screen.getByText('Auditing')).toBeDefined();
    expect(screen.queryByText('Auditing active')).toBeNull();
    expect(screen.getByText('registered · ~/.claude/settings.json')).toBeDefined();
    expect(screen.getByText('5m ago')).toBeDefined();
    expect(screen.getByText('3 / 1')).toBeDefined(); // pending / unreadable
    expect(await screen.findByText('2')).toBeDefined(); // flagged 7d, source axis
    expect(screen.getByText(/doesn't see raw MCP wire · no manifest monitoring/)).toBeDefined();
    expect(
      screen.getByText('MCP calls captured via Claude Code also appear under their connector.'),
    ).toBeDefined();
  });

  it('null status → em-dash placeholders, no badge', () => {
    stubXcg();
    render(<ClaudeCodeInspector status={null} onOpenInDetections={() => {}} />);
    expect(screen.queryByText('Auditing')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('Open in Detections fires the callback', () => {
    stubXcg();
    const onOpen = vi.fn();
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Detections →' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeInspector — Recent flagged calls (F1.5)', () => {
  it('lists source-filtered rows: severity badge, tool, category label, and counter matches', async () => {
    stubXcg([
      ccEvent({ toolName: 'notion-update-page' }),
      ccEvent({
        mcp: 'claude-code',
        toolName: 'Bash',
        detection: { category: 'data_export_warning', severity: 'medium', findings: [] },
      }),
      // Wrapper event for the same server — must NOT appear (source axis).
      (() => {
        const wrapper = ccEvent({ toolName: 'wrapper-only-call' });
        delete wrapper.source;
        return wrapper;
      })(),
    ]);
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);
    expect(await screen.findByText('notion-update-page')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.queryByText('wrapper-only-call')).toBeNull();
    expect(screen.getByText('Credential leak')).toBeDefined();
    expect(screen.getByText('Data export')).toBeDefined();
    expect(screen.getByText('HIGH')).toBeDefined();
    expect(screen.getByText('MEDIUM')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined(); // counter = list source, same predicate
  });

  it('caps the list at 8 while the counter keeps the full total', async () => {
    stubXcg(Array.from({ length: 10 }, (_, i) => ccEvent({ toolName: `tool-${i}` })));
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);
    expect(await screen.findByText('10')).toBeDefined(); // Flagged (7d) row
    await waitFor(() => {
      expect(screen.getAllByText(/^tool-\d+$/).length).toBe(8);
    });
  });

  it('empty state', async () => {
    stubXcg();
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);
    expect(await screen.findByText('No flagged calls.')).toBeDefined();
  });
});

describe('ClaudeCodeInspector — Uninstall hook (F1.3d)', () => {
  it('two-step confirmation: Uninstall hook → Confirm/Cancel; confirm calls cchookUninstall', async () => {
    const cchookUninstall = vi.fn(async () => ({ ok: true, outcome: 'wrote', settingsPath: '/tmp/s.json' }));
    stubXcg([], { cchookUninstall });
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    expect(cchookUninstall).not.toHaveBeenCalled(); // first click only arms the confirm
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }));
    await waitFor(() => expect(cchookUninstall).toHaveBeenCalledTimes(1));
  });

  it('Cancel disarms without calling; error result surfaces as a banner', async () => {
    const cchookUninstall = vi.fn(async () => ({ ok: false, error: 'settings.json is not valid JSON' }));
    stubXcg([], { cchookUninstall });
    render(<ClaudeCodeInspector status={STATUS} onOpenInDetections={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cchookUninstall).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Uninstall hook' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }));
    await waitFor(() => {
      expect(screen.getByText('settings.json is not valid JSON')).toBeDefined();
    });
  });

  it('no Uninstall button when the hook is not registered', () => {
    stubXcg();
    render(
      <ClaudeCodeInspector
        status={{ ...STATUS, hookRegistered: false }}
        onOpenInDetections={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Uninstall hook' })).toBeNull();
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-07-16T12:00:00.000Z');
  it('coarse buckets', () => {
    expect(formatRelative('2026-07-16T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelative('2026-07-16T11:15:00.000Z', now)).toBe('45m ago');
    expect(formatRelative('2026-07-16T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-07-14T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelative('garbage', now)).toBe('—');
  });
});
