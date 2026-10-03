// @vitest-environment jsdom
// The CHANGE block of the MCP Changes panel: a catalog review (review:
// 'baseline') judged the definition as it stands — nothing moved — so its
// block is titled "Definition", never "Change".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ChangeDetail } from '../../src/renderer/components/ChangeDetail.js';
import type { ConnectorChangeView } from '../../src/renderer/lib/xcgApi.js';

afterEach(() => {
  cleanup();
});

const view = (over: Partial<ConnectorChangeView> = {}): ConnectorChangeView => ({
  event_id: 'c1',
  ts: '2026-09-27T10:00:00.000Z',
  mcp: 'acme',
  section: 'tools',
  snapshot: { before: 'sha256:a', after: 'sha256:b' },
  changes: [{ kind: 'item_added', target: 'search' }],
  findings: [],
  attention: { level: 'normal' },
  review_status: 'unreviewed',
  review_history: [],
  ...over,
});

describe('ChangeDetail — block title', () => {
  it('a change titles its block "Change"', () => {
    render(<ChangeDetail change={view()} onReview={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Change')).toBeTruthy();
    expect(screen.queryByText('Definition')).toBeNull();
  });

  it('a catalog review titles it "Definition", never "Change"', () => {
    render(
      <ChangeDetail
        change={view({
          changes: [],
          snapshot: { before: null, after: 'sha256:cat' },
          review: 'baseline',
          reviewed_with: { injection_marker: 2 },
          findings: [
            {
              rule_id: 'injection_marker',
              rule_version: 2,
              severity: 'high',
              evidence: { target: 'send', path: '$.description', rule: 'ignore_other_tools' },
            },
          ],
        })}
        onReview={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Definition')).toBeTruthy();
    expect(screen.queryByText('Change')).toBeNull();
  });
});
