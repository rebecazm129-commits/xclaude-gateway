// The filtering and counting behind the Changes view.
//
// The load-bearing case is the findings-free majority: 197 of 217 real
// connector changes carry no severity at all, and every count and every filter
// has to have an answer for them that is not "low".

import { describe, expect, it } from 'vitest';

import type { ConnectorChangeView } from '../../src/renderer/lib/xcgApi.js';
import { needsReview, topSeverity } from '../../src/renderer/hooks/useChangePage.js';

let n = 0;
const change = (over: Partial<ConnectorChangeView> = {}): ConnectorChangeView => ({
  event_id: `e${(n += 1)}`,
  ts: '2026-09-24T11:00:00.000Z',
  mcp: 'notion',
  section: 'tools',
  snapshot: { before: 'sha256:a', after: 'sha256:b' },
  changes: [{ kind: 'description_changed', target: 'search' }],
  findings: [],
  attention: { level: 'normal' },
  review_status: 'unreviewed',
  review_history: [],
  ...over,
});

const finding = (severity: ConnectorChangeView['findings'][number]['severity']) => ({
  rule_id: 'sensitive_param_added',
  rule_version: 1,
  severity,
  evidence: { target: 'send' },
});

describe('topSeverity', () => {
  it('is null when no rule asserted one — null is not "low"', () => {
    // A change with no finding is not a small problem; it is no problem any
    // rule could name. Returning 'low' here would put a badge on 197 of 217
    // real changes.
    expect(topSeverity(change())).toBeNull();
  });

  it('is the highest of several findings', () => {
    expect(topSeverity(change({ findings: [finding('medium'), finding('high'), finding('low')] }))).toBe(
      'high',
    );
  });

  it('a lone finding is its own top', () => {
    expect(topSeverity(change({ findings: [finding('medium')] }))).toBe('medium');
  });
});

describe('needsReview', () => {
  it('findings, unreviewed → yes', () => {
    expect(needsReview(change({ findings: [finding('high')] }))).toBe(true);
  });

  it('attention raised, no findings, unreviewed → yes', () => {
    expect(
      needsReview(
        change({
          attention: { level: 'review_recommended', heuristic_id: 'h', heuristic_version: 1 },
        }),
      ),
    ).toBe(true);
  });

  it('neither findings nor attention → no, however recent', () => {
    expect(needsReview(change())).toBe(false);
  });

  it('reviewed → no, whatever it carries', () => {
    expect(
      needsReview(change({ findings: [finding('critical')], review_status: 'reviewed' })),
    ).toBe(false);
    expect(
      needsReview(
        change({
          review_status: 'reviewed',
          attention: { level: 'review_recommended', heuristic_id: 'h', heuristic_version: 1 },
        }),
      ),
    ).toBe(false);
  });
});
