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
import ccStyles from '../../src/renderer/components/ClaudeCode.module.css';
import type { DetectionFilter, DetectionPageResult, DetectionRowSlim } from '../../src/shared/types.js';

const EMPTY_PAGE: DetectionPageResult = {
  rows: [],
  total: 0,
  totalMatching: 0,
  severityCounts: { low: 0, medium: 0, high: 0, critical: 0 },
  categoryFilteredTotal: 0,
  nextCursor: null,
  facets: { tools: [], ccSessions: [], projects: [] },
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
    ccSession: 'uuid-B', argsSummary: 'git push origin', outcome: 'error',
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
  // Stable inventories (commit 6): the chips read THESE, not the filtered
  // rows. 'Read' has no row on this page — a stable facet can outlive it.
  facets: {
    tools: ['Bash', 'Read', 'toy_ping'],
    // Server session meta (delta final), recent-first. uuid-C has NO row on
    // this page — its human label must come from the facet alone.
    ccSessions: [
      { id: 'uuid-A', started: '2026-07-17T19:13:27.392Z', where: 'proj-a' },
      { id: 'uuid-B', started: '2026-07-17T19:13:22.000Z', where: 'claude-code' },
      { id: 'uuid-C', started: '2026-07-16T10:00:00.000Z', where: 'proj-c' },
    ],
    projects: ['proj-a'],
  },
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

  it('Tool chip: multi-select — unchecking one ships the remaining TWO as an array', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Tool/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Tool/ }));
    // All checked (≡ null). Unchecking 'Read' narrows to the other two.
    fireEvent.click(screen.getByLabelText('Read'));
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some(
          (f) => Array.isArray(f.tool) && [...f.tool].sort().join(',') === 'Bash,toy_ping',
        ),
      ).toBe(true);
    });
  });

  it('stable options: with an active tool filter, the menu still lists every tool', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Tool/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Tool/ }));
    fireEvent.click(screen.getByLabelText('Read')); // narrow: filter active
    // The dogfood bug: options must come from the stable facet inventory,
    // not from the filtered page — all three stay listed.
    for (const t of ['Bash', 'Read', 'toy_ping']) {
      expect(screen.getByLabelText(t)).toBeDefined();
    }
    // And nothing is disabled/locked — plain multi-select checkboxes.
    expect((screen.getByLabelText('Read') as HTMLInputElement).disabled).toBe(false);
  });

  it('Session chip: human labels one-line layout, unchecking ships the remaining ccSession', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Session/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Session/ }));
    // Human label, not the raw hash as primary; layout = single-line flex
    // (label ellipsizes, hash keeps its right slot).
    const inputA = screen.getByLabelText(/started .* · proj-a/);
    const labelA = inputA.closest('label')!;
    // Structural one-line contract, matched against the CSS-module exports
    // (vitest's stable strategy hashes class names — raw strings don't match).
    const spans = [...labelA.querySelectorAll('span')];
    const opt = spans.find((s) => s.className === ccStyles['sessionOption']);
    expect(opt).toBeDefined();
    expect(spans.some((s) => s.className === ccStyles['sessionOptionLabel'])).toBe(true);
    const hash = spans.find((s) => s.className === ccStyles['sessionHash']);
    expect(hash?.textContent).toBe('uuid-A');
    expect(screen.getByLabelText(/started .* · claude-code/)).toBeDefined();
    // Unchecking uuid-A narrows the filter to the remaining session.
    fireEvent.click(inputA);
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some(
          (f) => Array.isArray(f.ccSession) && [...f.ccSession].sort().join(',') === 'uuid-B,uuid-C',
        ),
      ).toBe(true);
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

  it('the floating "N flagged" counter is gone; the Flagged only chip covers it', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some((f) => f.categories.includes('tool_call_allowed')),
      ).toBe(true);
    });
    // No clickable counter in the toolbar anymore (commit 5b).
    expect(screen.queryByRole('button', { name: /flagged$/ })).toBeNull();
    // The chip carries the toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Flagged only' }));
    await waitFor(() => {
      const filters = shippedFilters(listDetectionPage);
      const last = filters[filters.length - 1]!;
      expect(last.categories.includes('tool_call_allowed')).toBe(false);
      expect(last.categories.sort()).toEqual([...FLAGGED_CATEGORIES].sort());
    });
  });

  it('toolbar band: two rows — search+time in row 1, chips in row 2 (incidencia B)', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    const { container } = render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Flagged only' })).toBeDefined());
    // CC's own multi-row band (the commit-5f shared single-row class cannot
    // hold this geometry; tokens stay identical). Beige band present:
    const bar = container.querySelector(`.${ccStyles['toolbar']}`);
    expect(bar).not.toBeNull();
    // Row 1 holds the search box; row 2 (chipsRow) holds the chips — the
    // search box and the chips are NOT siblings in one overflowing line.
    const search = screen.getByRole('searchbox', { name: 'Search tool or details' });
    const flagged = screen.getByRole('button', { name: 'Flagged only' });
    const chipsRow = container.querySelector(`.${ccStyles['chipsRow']}`);
    expect(chipsRow).not.toBeNull();
    expect(chipsRow?.contains(flagged)).toBe(true);
    expect(chipsRow?.contains(search)).toBe(false);
    // (Chip text nowrap and whole-chip wrapping are CSS-only — jsdom does not
    // apply stylesheets, so that part stays on visual verification.)
  });

  it('Custom active: date inputs join the chips row, never row 1 (dogfood 3ª ronda)', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    const { container } = render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From date');
    // The own-row band died: the date inputs live IN the chips row, next to
    // the chips, and never in row 1 with the search box.
    const chipsRow = container.querySelector(`.${ccStyles['chipsRow']}`);
    expect(chipsRow).not.toBeNull();
    expect(chipsRow?.contains(from)).toBe(true);
    expect(chipsRow?.contains(screen.getByRole('button', { name: 'Flagged only' }))).toBe(true);
    expect(chipsRow?.contains(screen.getByRole('searchbox', { name: 'Search tool or details' }))).toBe(false);
  });

  it('the 3 chips show the DOM tooltip on hover — rendered element, not an attribute', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Flagged only' })).toBeDefined());
    const cases: Array<[RegExp | string, string]> = [
      ['Flagged only', 'Show only calls that triggered a detection'],
      [/^Session/, 'Filter by Claude Code session'],
      [/^Project/, 'Filter by the folder where Claude Code was running'],
    ];
    for (const [name, text] of cases) {
      const btn = screen.getByRole('button', { name });
      // The Tooltip wrapper is the button's parent — hovering the chip area
      // enters it. The tip is a REAL element (role=tooltip): if it never
      // mounts (the Session failure mode), this find times out and FAILS.
      fireEvent.mouseEnter(btn.parentElement!);
      const tip = await screen.findByRole('tooltip');
      expect(tip.textContent).toBe(text);
      fireEvent.mouseLeave(btn.parentElement!);
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    }
    // Severity and Tool are self-explanatory: no tooltip at all (commit 5j) —
    // neither native title nor Tooltip wrapper.
    for (const name of [/^Severity/, /^Tool/]) {
      const btn = screen.getByRole('button', { name });
      expect(btn.getAttribute('title')).toBeNull();
      fireEvent.mouseEnter(btn.parentElement!);
      await new Promise((r) => setTimeout(r, 400));
      expect(screen.queryByRole('tooltip')).toBeNull();
    }
  });

  it('single-option chip: plain toggleable checkbox, never ships a filter (all ≡ none ≡ null)', async () => {
    const singleTool: DetectionPageResult = {
      ...EMPTY_PAGE,
      rows: [CC_ROWS[1]!], // only r2: toolName 'Bash', ccSession 'uuid-B'
      total: 1,
      totalMatching: 1,
      facets: { tools: ['Bash'], ccSessions: [{ id: 'uuid-B', started: '2026-07-17T19:13:22.000Z', where: 'claude-code' }], projects: [] },
    };
    const { listDetectionPage } = stubXcgForView(singleTool);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Tool/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Tool/ }));
    const checkbox = screen.getByLabelText('Bash') as HTMLInputElement;
    // Commit 6: no locked state — a 1-option toggle is legitimate because
    // all-unchecked ≡ all-checked ≡ null (no ghost narrowing possible).
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox); // all → none ≡ null
    fireEvent.click(checkbox); // none → all ≡ null
    await waitFor(() => expect(listDetectionPage).toHaveBeenCalled());
    expect(shippedFilters(listDetectionPage).every((f) => f.tool === null)).toBe(true);
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

describe('ClaudeCode — delta final (search, status, custom range, server session labels)', () => {
  it('session labels come from the SERVER facet: a session absent from the page still gets its human label', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Session/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Session/ }));
    // uuid-C has NO row in the loaded page — page-derived labelling is dead.
    expect(screen.getByLabelText(/started .* · proj-c/)).toBeDefined();
  });

  it('search box ships the debounced text filter', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    const box = await screen.findByRole('searchbox', { name: 'Search tool or details' });
    fireEvent.change(box, { target: { value: 'toy' } });
    await waitFor(() => {
      expect(shippedFilters(listDetectionPage).some((f) => f.text === 'toy')).toBe(true);
    });
  });

  it('Status chip ships ok/error membership', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Status/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Status/ }));
    fireEvent.click(screen.getByLabelText('OK')); // uncheck OK → only error
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some(
          (f) => Array.isArray(f.status) && f.status.join(',') === 'error',
        ),
      ).toBe(true);
    });
  });

  it('error rows show the discreet dot; ok/orphan rows do not', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByText('toy_ping')).toBeDefined());
    expect(screen.getAllByTestId('error-dot')).toHaveLength(1); // only r3
  });

  it('Custom time range: date inputs appear and ship {from,to} server-side', async () => {
    const { listDetectionPage } = stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From date');
    const to = screen.getByLabelText('To date');
    fireEvent.change(from, { target: { value: '2026-07-10' } });
    fireEvent.change(to, { target: { value: '2026-07-20' } });
    await waitFor(() => {
      expect(
        shippedFilters(listDetectionPage).some(
          (f) =>
            f.timeRange === 'custom' &&
            f.customRange?.from === '2026-07-10' &&
            f.customRange?.to === '2026-07-20',
        ),
      ).toBe(true);
    });
  });
});

describe('search end-to-end repro (incidencia A)', () => {
  // Exact dogfood case: a row whose Details is "SCRATCH=/private/tmp/…",
  // the user types "scratch" → the list itself must filter. The stub runs
  // the REAL paginate, so this covers input → debounce → IPC → server match
  // → render — not just the shipped filter (the old test's blind spot).
  function evt(id: string, toolName: string, argsSummary: string): unknown {
    return {
      id, ts: new Date(Date.now() - 1000).toISOString(), session: 's', mcp: 'claude-code',
      type: 'mcp.request', method: 'tools/call', rpcId: id, direction: 'client_to_server',
      source: 'claude-code', ccSession: 'uuid-A', toolName, argsSummary,
      detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
    };
  }

  it('typing "scratch" filters the visible list down to the SCRATCH row', async () => {
    const { paginate } = await import('../../src/main/detection-page.js');
    const events = [
      evt('m1', 'Bash', 'SCRATCH=/private/tmp/x; pnpm exec tsc'),
      evt('n1', 'Read', 'apps/desktop/src/main/x.ts'),
      evt('n2', 'Write', 'notes.md'),
    ] as never[];
    const listDetectionPage = vi.fn(async (params: { filter: never }) => {
      const slice = paginate(events, params.filter, 200, null, Date.now());
      return { ...slice, authAlerts: [], retention: null };
    });
    vi.stubGlobal('xcg', { listDetectionPage });
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByText('notes.md')).toBeDefined());
    const box = screen.getByRole('searchbox', { name: 'Search tool or details' });
    fireEvent.change(box, { target: { value: 'scratch' } });
    // The IPC call carries the text…
    await waitFor(() => {
      expect(
        listDetectionPage.mock.calls.some(
          (c) => (c[0] as { filter: { text?: string | null } }).filter.text === 'scratch',
        ),
      ).toBe(true);
    });
    // …and the LIST is actually filtered: only the SCRATCH row survives.
    await waitFor(() => {
      expect(screen.queryByText('notes.md')).toBeNull();
      expect(screen.getByText(/SCRATCH=/)).toBeDefined();
    });
  });
});

describe('CC empty state (dogfood 22/07)', () => {
  // Real-paginate e2e (the incidencia-A pattern): the fork under test is
  // "server-filtered empty page + renderer filter state", so the stub must
  // actually filter — a fixed page would assert nothing.
  function evt(id: string, toolName: string, argsSummary: string): unknown {
    return {
      id, ts: new Date(Date.now() - 1000).toISOString(), session: 's', mcp: 'claude-code',
      type: 'mcp.request', method: 'tools/call', rpcId: id, direction: 'client_to_server',
      source: 'claude-code', ccSession: 'uuid-A', toolName, argsSummary,
      detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
    };
  }

  async function renderWithRealPaginate(events: unknown[]): Promise<void> {
    const { paginate } = await import('../../src/main/detection-page.js');
    const listDetectionPage = vi.fn(async (params: { filter: never }) => {
      const slice = paginate(events as never[], params.filter, 200, null, Date.now());
      return { ...slice, authAlerts: [], retention: null };
    });
    vi.stubGlobal('xcg', { listDetectionPage });
    render(<ClaudeCode />);
  }

  it('no-match search → filtered empty state with Clear filters, NOT the onboarding message', async () => {
    await renderWithRealPaginate([evt('m1', 'Bash', 'echo hola')]);
    await waitFor(() => expect(screen.getByText('Bash')).toBeDefined());
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search tool or details' }),
      { target: { value: 'adsfas' } },
    );
    // The dogfood bug: this used to render the onboarding message.
    const clear = await screen.findByRole('button', { name: 'Clear filters' });
    expect(clear).toBeDefined();
    expect(screen.getByText('No matches with current filters')).toBeDefined();
    expect(screen.queryByText(/No Claude Code activity yet/)).toBeNull();
  });

  it('Clear filters restores the list and empties the search box', async () => {
    await renderWithRealPaginate([evt('m1', 'Bash', 'echo hola')]);
    await waitFor(() => expect(screen.getByText('Bash')).toBeDefined());
    const box = screen.getByRole('searchbox', { name: 'Search tool or details' });
    fireEvent.change(box, { target: { value: 'adsfas' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('Bash')).toBeDefined());
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('no activity and no filters → onboarding message intact, no Clear button', async () => {
    await renderWithRealPaginate([]);
    await waitFor(() => {
      expect(screen.getByText(/No Claude Code activity yet/)).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});

describe('error dot tooltip (delta de cierre m)', () => {
  it('hovering the dot shows "This call failed" via the house Tooltip', async () => {
    stubXcgForView(PAGE_WITH_ROWS);
    render(<ClaudeCode />);
    await waitFor(() => expect(screen.getByTestId('error-dot')).toBeDefined());
    const dot = screen.getByTestId('error-dot');
    expect(dot.getAttribute('aria-label')).toBe('This call failed');
    fireEvent.mouseEnter(dot.parentElement!); // the Tooltip wrap
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('This call failed');
  });
});
