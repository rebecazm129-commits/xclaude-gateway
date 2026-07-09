// @vitest-environment jsdom
// Component tests for the DetailDrawer findings section: duplicated
// (type, location) findings collapse into one row with a ×N counter, while
// distinct types never merge (the deliberate nl_bsn/pt_nif multi-label).
// window.xcg.detectionDetail is stubbed per test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DetailDrawer, groupFindings } from '../../src/renderer/components/DetailDrawer.js';
import type { DetectionDetail, DetectionRowSlim } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW: DetectionRowSlim = {
  id: 'e1',
  ts: '2026-07-07T19:09:05.838Z',
  mcp: 'drive',
  type: 'mcp.detection_enrichment',
  category: 'pii_structured',
  severity: 'medium',
};

function detail(findings: DetectionDetail['findings']): DetectionDetail {
  return {
    id: 'e1',
    ts: '2026-07-07T19:09:05.838Z',
    session: '01HXTESTSESSION',
    mcp: 'drive',
    type: 'mcp.detection_enrichment',
    rpcId: 2,
    direction: 'server_to_client',
    category: 'pii_structured',
    severity: 'medium',
    findings,
  };
}

function stubDetail(d: DetectionDetail): void {
  vi.stubGlobal('xcg', { detectionDetail: vi.fn(async () => d) });
}

describe('DetailDrawer — findings grouping', () => {
  it('collapses identical (type, location) findings into one row with a counter', async () => {
    stubDetail(detail(Array.from({ length: 20 }, () => ({ type: 'email', location: 'result' }))));
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('×20')).toBeTruthy();
    // One collapsed row, not twenty.
    expect(screen.getAllByText('email')).toHaveLength(1);
    expect(screen.getAllByText('result')).toHaveLength(1);
  });

  it('never merges across types: nl_bsn/pt_nif multi-label stays two rows, no counter', async () => {
    stubDetail(
      detail([
        { type: 'nl_bsn', location: 'result' },
        { type: 'pt_nif', location: 'result' },
      ]),
    );
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('nl_bsn')).toBeTruthy();
    expect(screen.getByText('pt_nif')).toBeTruthy();
    // ×N counter pattern — /×\d/, not /×/, which would match the drawer's own close button.
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it('same type on different locations stays two rows (grouping key is type AND location)', async () => {
    stubDetail(
      detail([
        { type: 'email', location: 'params' },
        { type: 'email', location: 'result' },
        { type: 'email', location: 'result' },
      ]),
    );
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('×2')).toBeTruthy();
    expect(screen.getAllByText('email')).toHaveLength(2);
  });
});

describe('groupFindings', () => {
  it('preserves first-seen order and counts per (type, location)', () => {
    expect(
      groupFindings([
        { type: 'email', location: 'result' },
        { type: 'iban', location: 'result' },
        { type: 'email', location: 'result' },
      ]),
    ).toEqual([
      { type: 'email', location: 'result', count: 2 },
      { type: 'iban', location: 'result', count: 1 },
    ]);
  });

  it('treats a missing location as its own group', () => {
    expect(groupFindings([{ type: 'email' }, { type: 'email', location: 'params' }])).toEqual([
      { type: 'email', count: 1 },
      { type: 'email', location: 'params', count: 1 },
    ]);
  });
});
