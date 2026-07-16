// @vitest-environment jsdom
// End-to-end case for the sources preset (F1.3c): Detections arrives with
// sourcesPreset from outside (the Claude Code inspector's Open in Detections),
// applies it to its own Source pill and acknowledges consumption.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { Detections } from '../../src/renderer/components/Detections.js';
import type { DetectionPageResult } from '../../src/shared/types.js';

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
});
