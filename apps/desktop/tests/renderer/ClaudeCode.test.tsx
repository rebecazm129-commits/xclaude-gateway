// @vitest-environment jsdom
// F2.4 commit 2: the Claude Code tab exists and navigates, the view mounts
// and paints CC rows (own row layout: badge · tool · context · when), and the
// source filter is FIXED — no Source chip in the UI, every page request pins
// sources: ['claude-code'].

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from '../../src/renderer/App.js';
import { ClaudeCode } from '../../src/renderer/components/ClaudeCode.js';
import type { DetectionPageResult, DetectionRowSlim } from '../../src/shared/types.js';

const EMPTY_PAGE: DetectionPageResult = {
  rows: [],
  total: 0,
  totalMatching: 0,
  severityCounts: { low: 0, medium: 0, high: 0, critical: 0 },
  categoryFilteredTotal: 0,
  nextCursor: null,
  authAlerts: [],
  retention: null,
};

const CC_ROWS: DetectionRowSlim[] = [
  {
    id: 'r1', ts: '2026-07-17T19:13:27.392Z', mcp: 'xcg-toy', type: 'mcp.request',
    category: 'tool_call_allowed', severity: 'low', source: 'claude-code',
    toolName: 'toy_ping', method: 'tools/call',
    ccSession: 'uuid-A', project: 'proj-a',
  },
  {
    id: 'r2', ts: '2026-07-17T19:13:24.865Z', mcp: 'claude-code', type: 'mcp.request',
    category: 'tool_call_allowed', severity: 'low', source: 'claude-code',
    toolName: 'Bash', method: 'tools/call',
    // No project (historical envelope, forward-only): context falls back to mcp.
  },
];

const PAGE_WITH_ROWS: DetectionPageResult = {
  ...EMPTY_PAGE,
  rows: CC_ROWS,
  total: 2,
  totalMatching: 2,
};

function stubXcgForView(page: DetectionPageResult): ReturnType<typeof vi.fn> {
  const listDetectionPage = vi.fn(async () => page);
  vi.stubGlobal('xcg', { listDetectionPage });
  return listDetectionPage;
}

// App mounts Setup (initial tab) + the polled hooks, so the stub needs their
// whole surface — same fixture style as Setup.test.tsx.
function stubXcgForApp(): ReturnType<typeof vi.fn> {
  const listDetectionPage = vi.fn(async () => EMPTY_PAGE);
  vi.stubGlobal('xcg', {
    listDetectionPage,
    validateHealth: vi.fn(async () => ({ status: 'healthy', checks: [] })),
    configStatus: vi.fn(async () => ({ ok: false })),
    listDetections: vi.fn(async () => ({ events: [], authAlerts: [] })),
    configIsConnected: vi.fn(async () => ({ ok: true, connected: false })),
    configHasClient: vi.fn(async () => false),
    cchookStatus: vi.fn(async () => ({
      installed: false, hookRegistered: false, pendingSpool: 0,
      unreadableTotal: 0, lastCycle: null, lastSessionStartTs: null,
    })),
  });
  return listDetectionPage;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Claude Code tab (F2.4)', () => {
  it('appears third in the tab bar and navigates to the view', async () => {
    stubXcgForApp();
    render(<App />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Sources', 'Detections', 'Claude Code']);
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    // The view's empty state is its marker (stub returns an empty page).
    await waitFor(() => {
      expect(screen.getByText(/No Claude Code activity yet/)).toBeDefined();
    });
  });
});

describe('ClaudeCode view (F2.4)', () => {
  it('mounts and paints CC rows: tool, context (project or mcp fallback), when', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText('toy_ping')).toBeDefined();
    });
    // Context column: project when present, mcp as fallback.
    expect(screen.getByText('proj-a')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText('claude-code')).toBeDefined();
    // Column headers of the CC design, When last.
    const headers = ['Severity', 'Tool', 'Context', 'When'];
    for (const h of headers) expect(screen.getByText(h)).toBeDefined();
  });

  it('source filter is fixed: no Source chip, every page call pins claude-code', async () => {
    const listDetectionPage = stubXcgForView(EMPTY_PAGE);
    render(<ClaudeCode />);
    await waitFor(() => expect(listDetectionPage).toHaveBeenCalled());
    // No UI control to alter the source (Detections' pill is absent).
    expect(screen.queryByRole('button', { name: /Source/ })).toBeNull();
    // And the filter shipped to main is pinned on every call.
    for (const call of listDetectionPage.mock.calls) {
      const params = call[0] as { filter: { sources: string[] } };
      expect(params.filter.sources).toEqual(['claude-code']);
    }
  });
});
