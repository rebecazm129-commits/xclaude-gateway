// @vitest-environment jsdom
// F2.4: the Claude Code tab exists and navigates; the view paints CC rows
// (badge · tool · args · when, with the Context fallback), the source filter
// is FIXED, the chips drive the server-side filters from commit 1, the
// flagged counter toggles Flagged only, and session separators appear on
// ccSession changes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from '../../src/renderer/App.js';
import { ClaudeCode, buildListItems, FLAGGED_CATEGORIES } from '../../src/renderer/components/ClaudeCode.js';
import type { DetectionFilter, DetectionPageResult, DetectionRowSlim } from '../../src/shared/types.js';

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
    ccSession: 'uuid-A', project: 'proj-a', argsSummary: 'echo hola',
  },
  {
    id: 'r2', ts: '2026-07-17T19:13:24.865Z', mcp: 'claude-code', type: 'mcp.request',
    category: 'tool_call_allowed', severity: 'low', source: 'claude-code',
    toolName: 'Bash', method: 'tools/call',
    ccSession: 'uuid-B',
    // No project/argsSummary: the Args cell falls back to Context (mcp).
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

function shippedFilters(mock: ReturnType<typeof vi.fn>): DetectionFilter[] {
  return mock.mock.calls.map((c) => (c[0] as { filter: DetectionFilter }).filter);
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
  it('paints CC rows: tool, args summary with Context fallback, headers', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText('toy_ping')).toBeDefined();
    });
    // Args column: argsSummary when present, Context (project ?? mcp) fallback.
    expect(screen.getByText('echo hola')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText('claude-code')).toBeDefined();
    // Column headers of the CC design, Args third, When last.
    for (const h of ['Severity', 'Tool', 'Args', 'When']) {
      expect(screen.getByText(h)).toBeDefined();
    }
  });

  it('source filter is fixed: no Source chip, every page call pins claude-code', async () => {
    const mock = stubXcgForView(EMPTY_PAGE);
    render(<ClaudeCode />);
    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Source/ })).toBeNull();
    for (const f of shippedFilters(mock)) {
      expect(f.sources).toEqual(['claude-code']);
    }
  });

  it('Tool chip ships the server-side tool filter', async () => {
    const mock = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Tool/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Tool/ }));
    fireEvent.click(screen.getByLabelText('Bash'));
    await waitFor(() => {
      expect(shippedFilters(mock).some((f) => f.tool === 'Bash')).toBe(true);
    });
  });

  it('Session chip ships the server-side ccSession filter', async () => {
    const mock = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Session/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Session/ }));
    fireEvent.click(screen.getByLabelText('uuid-A'));
    await waitFor(() => {
      expect(shippedFilters(mock).some((f) => f.ccSession === 'uuid-A')).toBe(true);
    });
  });

  it('flagged counter shows the probe count and toggles Flagged only', async () => {
    const mock = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    // Counter text from the flagged-pinned probe (stub returns totalMatching 2).
    const counter = await screen.findByRole('button', { name: '2 flagged' });
    // Before the click, the MAIN list ships the full category set.
    await waitFor(() => {
      expect(
        shippedFilters(mock).some((f) => f.categories.includes('tool_call_allowed')),
      ).toBe(true);
    });
    fireEvent.click(counter);
    // After the click every fresh call excludes the baseline category.
    await waitFor(() => {
      const filters = shippedFilters(mock);
      const last = filters[filters.length - 1]!;
      expect(last.categories.includes('tool_call_allowed')).toBe(false);
      expect(last.categories.sort()).toEqual([...FLAGGED_CATEGORIES].sort());
    });
  });

  it('session separators appear where ccSession changes', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText(/uuid-A · proj-a/)).toBeDefined();
    });
    // Second block: no project → mcp in the separator label.
    expect(screen.getByText(/uuid-B · claude-code/)).toBeDefined();
  });
});

describe('buildListItems (F2.4)', () => {
  it('inserts a separator before each ccSession block; sessionless rows get none', () => {
    const mk = (id: string, ts: string, cc?: string): DetectionRowSlim => ({
      id, ts, mcp: 'm', type: 'mcp.request', category: 'tool_call_allowed',
      severity: 'low', source: 'claude-code',
      ...(cc !== undefined ? { ccSession: cc } : {}),
    });
    const rows = [
      mk('a1', '2026-07-17T19:15:00.000Z', 'uuid-A'),
      mk('a2', '2026-07-17T19:14:00.000Z', 'uuid-A'),
      mk('b1', '2026-07-17T19:13:00.000Z', 'uuid-B'),
      mk('h1', '2026-07-17T19:12:00.000Z'), // historical: no ccSession
    ];
    const items = buildListItems(rows);
    expect(items.map((i) => i.kind)).toEqual([
      'separator', 'row', 'row', 'separator', 'row', 'row',
    ]);
    const seps = items.filter((i) => i.kind === 'separator');
    expect(seps[0]?.kind === 'separator' && seps[0].ccSession).toBe('uuid-A');
    expect(seps[1]?.kind === 'separator' && seps[1].ccSession).toBe('uuid-B');
    // Block time span rides the label (oldest–newest of the block).
    expect(seps[0]?.kind === 'separator' && seps[0].label).toContain('uuid-A');
  });
});
