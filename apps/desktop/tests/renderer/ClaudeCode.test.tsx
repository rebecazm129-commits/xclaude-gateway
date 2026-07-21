// @vitest-environment jsdom
// F2.4 (commit 4 shape): the Claude Code tab exists and navigates; the view
// paints CC rows in Detections' column order (Time · Severity · Tool ·
// Details), shows the severity cards band, prefixes the readable category on
// flagged rows, renders enrichments with their category as Details, hides
// the Project chip when no loaded row has a project, redesigned session
// separators (no hash), and ships the CC filter (fixed sources) to export.

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
    // No project/argsSummary: the Details cell falls back to mcp.
  },
  {
    // Flagged request: readable category label prefixes Details.
    id: 'r3', ts: '2026-07-17T19:13:23.100Z', mcp: 'claude-code', type: 'mcp.request',
    category: 'data_export_warning', severity: 'medium', source: 'claude-code',
    toolName: 'Bash', method: 'tools/call',
    ccSession: 'uuid-B', argsSummary: 'git push origin',
  },
  {
    // CC enrichment: Details = category label, Tool = producer label.
    id: 'r4', ts: '2026-07-17T19:13:22.000Z', mcp: 'xcg-toy',
    type: 'mcp.detection_enrichment',
    category: 'pii_detected', severity: 'medium', source: 'claude-code',
    ccSession: 'uuid-B',
  },
];

const PAGE_WITH_ROWS: DetectionPageResult = {
  ...EMPTY_PAGE,
  rows: CC_ROWS,
  total: 4,
  totalMatching: 4,
  severityCounts: { low: 2, medium: 2, high: 0, critical: 0 },
  categoryFilteredTotal: 4,
};

function stubXcgForView(page: DetectionPageResult): {
  listDetectionPage: ReturnType<typeof vi.fn>;
  exportAudit: ReturnType<typeof vi.fn>;
} {
  const listDetectionPage = vi.fn(async () => page);
  const exportAudit = vi.fn(async () => ({ ok: true, count: page.totalMatching }));
  vi.stubGlobal('xcg', { listDetectionPage, exportAudit });
  return { listDetectionPage, exportAudit };
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
    await waitFor(() => {
      expect(screen.getByText(/No Claude Code activity yet/)).toBeDefined();
    });
  });
});

describe('ClaudeCode view (F2.4 commit 4)', () => {
  it('paints rows in Detections order with Details fallback, and the cards band', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText('toy_ping')).toBeDefined();
    });
    // Details column: argsSummary when present, project ?? mcp fallback.
    expect(screen.getByText('echo hola')).toBeDefined();
    expect(screen.getByText('claude-code')).toBeDefined(); // r2 fallback (exact node)
    // Column headers: Detections' order and naming.
    for (const h of ['Time', 'Severity', 'Tool', 'Details']) {
      expect(screen.getByText(h)).toBeDefined();
    }
    // Severity cards band with the CC page's counts.
    for (const label of ['Total', 'Low', 'Medium', 'High', 'Critical']) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText('4')).toBeDefined(); // Total card = categoryFilteredTotal
  });

  it('flagged rows prefix the readable category; baseline rows never do', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText('Data export')).toBeDefined(); // r3 prefix
    });
    expect(screen.queryByText('Tool call')).toBeNull(); // baseline label never shown
  });

  it('enrichment rows: producer label as Tool, category label as Details', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText('[NER]')).toBeDefined();
    });
    expect(screen.getByText('PII detected')).toBeDefined();
  });

  it('source filter is fixed: no Source chip, every page call pins claude-code', async () => {
    const { listDetectionPage } = stubXcgForView(EMPTY_PAGE);
    render(<ClaudeCode />);
    await waitFor(() => expect(listDetectionPage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Source/ })).toBeNull();
    for (const f of shippedFilters(listDetectionPage)) {
      expect(f.sources).toEqual(['claude-code']);
    }
  });

  it('Tool chip ships the server-side tool filter', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Tool/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Tool/ }));
    fireEvent.click(screen.getByLabelText('Bash'));
    await waitFor(() => {
      expect(shippedFilters(listDetectionPage).some((f) => f.tool === 'Bash')).toBe(true);
    });
  });

  it('Session chip ships the server-side ccSession filter', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Session/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Session/ }));
    fireEvent.click(screen.getByLabelText('uuid-A'));
    await waitFor(() => {
      expect(shippedFilters(listDetectionPage).some((f) => f.ccSession === 'uuid-A')).toBe(true);
    });
  });

  it('Project chip is hidden with no projects loaded, visible when one exists', async () => {
    const { listDetectionPage } = stubXcgForView(EMPTY_PAGE);
    render(<ClaudeCode />);
    await waitFor(() => expect(listDetectionPage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Project/ })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    stubXcgForView(PAGE_WITH_ROWS); // r1 carries proj-a
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Project/ })).toBeDefined();
    });
  });

  it('flagged counter shows the probe count and toggles Flagged only', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    const counter = await screen.findByRole('button', { name: '4 flagged' });
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some((f) => f.categories.includes('tool_call_allowed')),
      ).toBe(true);
    });
    fireEvent.click(counter);
    await waitFor(() => {
      const filters = shippedFilters(listDetectionPage);
      const last = filters[filters.length - 1]!;
      expect(last.categories.includes('tool_call_allowed')).toBe(false);
      expect(last.categories.sort()).toEqual([...FLAGGED_CATEGORIES].sort());
    });
  });

  it('session separators: project (or mcp) + started stamp, no hash', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(screen.getByText(/proj-a · started/)).toBeDefined();
    });
    expect(screen.getByText(/claude-code · started/)).toBeDefined();
    // Hash dropped from the separator (session ids only live in the chip menu).
    expect(screen.queryByText(/uuid-A ·/)).toBeNull();
  });

  it('export ships the CC filter with fixed sources', async () => {
    const { exportAudit } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    const exportBtn = await screen.findByRole('button', { name: 'Export 4 events' });
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportAudit).toHaveBeenCalled());
    const [filter, format] = exportAudit.mock.calls[0] as [DetectionFilter, string];
    expect(filter.sources).toEqual(['claude-code']);
    expect(format).toBe('jsonl');
  });
});

describe('buildListItems (F2.4)', () => {
  it('separator before each ccSession block; label = project/mcp + started; sessionless rows get none', () => {
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
    // Redesigned label: project (mcp fallback here) + started stamp, no hash.
    expect(seps[0]?.kind === 'separator' && seps[0].label).toMatch(/^m · started /);
    expect(seps[0]?.kind === 'separator' && seps[0].label).not.toContain('uuid-A');
  });
});
