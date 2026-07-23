// @vitest-environment jsdom
// End-to-end case for the sources preset (F1.3c): Detections arrives with
// sourcesPreset from outside (the Claude Code inspector's Open in Detections),
// applies it to its own Source pill and acknowledges consumption.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { Detections } from '../../src/renderer/components/Detections.js';
// The toolbar band classes live in ClaudeCode.module.css (shared band since
// the toolbar parity 22/07) — the structural contract matches against them.
// detStyles: the filtered-empty state family, for scoping when the inline
// Clear (producto 22/07) coexists with the empty state's button.
import ccStyles from '../../src/renderer/components/ClaudeCode.module.css';
import detStyles from '../../src/renderer/components/Detections.module.css';
import type { DetectionPageResult } from '../../src/shared/types.js';

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

function stubXcg(): { listDetectionPage: ReturnType<typeof vi.fn> } {
  const listDetectionPage = vi.fn(async () => EMPTY_PAGE);
  vi.stubGlobal('xcg', { listDetectionPage });
  return { listDetectionPage };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Detections — sources preset (F1.3c)', () => {
  it('arriving preset selects the Source pill and is consumed once', async () => {
    stubXcg();
    const onConsumed = vi.fn();
    render(
      <Detections
        mcpFilter={null}
        onClearMcpFilter={() => {}}
        sourcesPreset={['claude-code']}
        onSourcesPresetConsumed={onConsumed}
      />,
    );
    // The pill trigger reflects the narrowed selection (1 of 2 sources).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Source \(1\/2\)/ })).toBeDefined();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('without preset the Source pill starts with both selected', async () => {
    const { listDetectionPage } = stubXcg();
    render(<Detections mcpFilter={null} onClearMcpFilter={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Source \(2\/2\)/ })).toBeDefined();
    });
    // And the filter shipped to main carries both sources.
    await waitFor(() => expect(listDetectionPage).toHaveBeenCalled());
    const call = listDetectionPage.mock.calls[0]?.[0] as { filter: { sources: string[] } };
    expect(call.filter.sources.sort()).toEqual(['claude-code', 'gateway']);
  });

  it('the toolbar "N events" counter is gone (F2.4 commit 5i — the Total card owns it)', async () => {
    stubXcg();
    render(<Detections mcpFilter={null} onClearMcpFilter={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Source \(2\/2\)/ })).toBeDefined();
    });
    // Old label shapes: "0 events" (no filters) / "0 of 0" (filtered). The
    // footer's "Export 0 events" button is a different, whole-element text.
    expect(screen.queryByText(/^\d+ events$/)).toBeNull();
    expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull();
  });
});

describe('Detections — filter parity: search + custom range (22/07)', () => {
  // Gateway-shaped events (no `source` field → normalizeSource ⇒ 'gateway')
  // run through the REAL paginate — the F2.4 lesson (incidencia A): assert
  // the rendered list, not just the shipped IPC filter.
  function evt(id: string, ts: string, toolName: string, argsSummary: string): unknown {
    return {
      id, ts, session: 's', mcp: 'notion', type: 'mcp.request',
      method: 'tools/call', rpcId: id, direction: 'client_to_server',
      toolName, argsSummary,
      detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
    };
  }

  async function renderWithRealPaginate(
    events: unknown[],
  ): Promise<ReturnType<typeof render>> {
    const { paginate } = await import('../../src/main/detection-page.js');
    const listDetectionPage = vi.fn(async (params: { filter: never }) => {
      const slice = paginate(events as never[], params.filter, 200, null, Date.now());
      return { ...slice, authAlerts: [], retention: null };
    });
    vi.stubGlobal('xcg', { listDetectionPage });
    return render(<Detections mcpFilter={null} onClearMcpFilter={() => {}} />);
  }

  it('typing in the search box filters the rendered list of gateway rows', async () => {
    await renderWithRealPaginate([
      evt('g1', new Date(Date.now() - 1000).toISOString(), 'notion-fetch', 'id 123abc'),
      evt('g2', new Date(Date.now() - 2000).toISOString(), 'Bash', 'git push origin'),
    ]);
    await waitFor(() => expect(screen.getByText('Bash')).toBeDefined());
    const box = screen.getByRole('searchbox', { name: 'Search tool or details' });
    fireEvent.change(box, { target: { value: 'notion' } });
    await waitFor(() => {
      expect(screen.queryByText('Bash')).toBeNull();
      expect(screen.getByText('notion-fetch')).toBeDefined();
    });
  });

  it('Custom range: date inputs in the chips row narrow the list to the window', async () => {
    const { container } = await renderWithRealPaginate([
      evt('old1', '2026-07-10T12:00:00.000Z', 'notion-fetch', 'id 123abc'),
      evt('new1', new Date(Date.now() - 1000).toISOString(), 'Bash', 'git push origin'),
    ]);
    await waitFor(() => expect(screen.getByText('Bash')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From date');
    // Structural contract (dogfood 3ª ronda): the date inputs live IN the
    // chips row, alongside the chips — no own-row band, and never in row 1
    // with the search box.
    const chipsRow = container.querySelector(`.${ccStyles['chipsRow']}`);
    expect(chipsRow).not.toBeNull();
    expect(chipsRow?.contains(from)).toBe(true);
    expect(chipsRow?.contains(screen.getByRole('button', { name: /Severity/ }))).toBe(true);
    expect(chipsRow?.contains(screen.getByRole('searchbox', { name: 'Search tool or details' }))).toBe(false);
    fireEvent.change(from, { target: { value: '2026-07-09' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-07-11' } });
    await waitFor(() => {
      expect(screen.queryByText('Bash')).toBeNull();
      expect(screen.getByText('notion-fetch')).toBeDefined();
    });
  });

  it('Clear filters resets search + custom range and restores the list', async () => {
    const { container } = await renderWithRealPaginate([
      evt('g1', new Date(Date.now() - 1000).toISOString(), 'notion-fetch', 'id 123abc'),
    ]);
    await waitFor(() => expect(screen.getByText('notion-fetch')).toBeDefined());
    const box = screen.getByRole('searchbox', { name: 'Search tool or details' });
    fireEvent.change(box, { target: { value: 'zzz-no-match' } });
    // No-match search → the filtered empty state. Its button coexists with
    // the inline one in the chips row (producto 22/07) — scope by container.
    const emptyState = await waitFor(() => {
      const el = container.querySelector(`.${detStyles['emptyFiltered']}`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('notion-fetch')).toBeDefined());
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('inline Clear filters (producto 22/07): absent without filters, appears with one and restores everything', async () => {
    await renderWithRealPaginate([
      evt('g1', new Date(Date.now() - 1000).toISOString(), 'notion-fetch', 'id 123abc'),
    ]);
    await waitFor(() => expect(screen.getByText('notion-fetch')).toBeDefined());
    // Default state: no reset control anywhere.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    // Activate ONE filter that keeps the (recent) row visible: the list
    // stays, so the inline control is the only Clear button in the DOM.
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    const clear = await screen.findByRole('button', { name: 'Clear filters' });
    fireEvent.click(clear);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('notion-fetch')).toBeDefined();
  });
});
