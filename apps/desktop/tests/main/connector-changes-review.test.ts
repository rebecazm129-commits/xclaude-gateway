// Catalog review lines in the desktop reader: the review fields pass through,
// and a duplicate process's identical consecutive review lines collapse in
// presentation only — the trail keeps every line.

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONNECTOR_CHANGE_TYPE, REVIEW_STATUS_CHANGED_TYPE } from '@xcg/shared';

import {
  collapseDuplicates,
  fromNativeLine,
  readConnectorChanges,
  type ConnectorChangeView,
} from '../../src/main/connector-changes.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-review-reader-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

let n = 0;
const FINDING = {
  rule_id: 'injection_marker',
  rule_version: 2,
  severity: 'high',
  evidence: { target: 'send', path: '$.description', rule: 'ignore_other_tools' },
};
const REVIEWED_WITH = { injection_marker: 2, sensitive_path_reference: 1, hidden_characters: 2 };

function reviewLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: `R${(n += 1)}`,
    ts: '2026-09-27T10:00:00.000Z',
    session: 'S',
    mcp: 'notion',
    type: CONNECTOR_CHANGE_TYPE,
    section: 'tools',
    snapshot: { before: null, after: 'sha256:cat' },
    changes: [],
    findings: [FINDING],
    attention: { level: 'normal' },
    review: 'baseline',
    reviewed_with: REVIEWED_WITH,
    ...over,
  };
}
const changeLine = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  reviewLine({ review: undefined, reviewed_with: undefined, snapshot: { before: 'sha256:a', after: 'sha256:b' }, changes: [{ kind: 'description_changed', target: 'search' }], findings: [], ...over });

async function dirWith(...lines: unknown[]): Promise<string> {
  const d = join(tmpDir, `case-${(n += 1)}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '01HX.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return d;
}
const view = (line: Record<string, unknown>): ConnectorChangeView => fromNativeLine(line)!;

describe('review fields in the reader', () => {
  it('review and reviewed_with pass through', () => {
    const v = view(reviewLine());
    expect(v.review).toBe('baseline');
    expect(v.reviewed_with).toEqual(REVIEWED_WITH);
    expect(v.changes).toEqual([]);
  });

  it('an unknown review value is not carried, and a change line has neither field', () => {
    expect('review' in view(reviewLine({ review: 'something-else' }))).toBe(false);
    const c = view(changeLine());
    expect('review' in c).toBe(false);
    expect('reviewed_with' in c).toBe(false);
  });
});

describe('collapseDuplicates — review lines of a duplicate process', () => {
  it('two identical consecutive review lines of one connector show once; the trail keeps both', async () => {
    const d = await dirWith(
      reviewLine({ ts: '2026-09-27T10:00:00.000Z', session: 'S1' }),
      reviewLine({ ts: '2026-09-27T10:00:00.400Z', session: 'S2' }),
    );
    const rows = await readConnectorChanges(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts).toBe('2026-09-27T10:00:00.400Z');
  });

  it('a reviewed copy wins, so a mark is never hidden', async () => {
    const first = reviewLine({ id: 'RA', ts: '2026-09-27T10:00:00.000Z' });
    const second = reviewLine({ id: 'RB', ts: '2026-09-27T10:00:01.000Z' });
    const marker = {
      v: 1, id: 'M1', ts: '2026-09-27T11:00:00.000Z', session: 'desktop',
      type: REVIEW_STATUS_CHANGED_TYPE, target_event_id: 'RA', from: 'unreviewed', to: 'reviewed',
    };
    const rows = await readConnectorChanges(await dirWith(first, second, marker));
    expect(rows.map((r) => [r.event_id, r.review_status])).toEqual([['RA', 'reviewed']]);
  });

  it('another connector in between does not break the run', () => {
    const rows = collapseDuplicates([
      view(reviewLine({ ts: '2026-09-27T10:00:02.000Z' })),
      view(reviewLine({ mcp: 'stripe', ts: '2026-09-27T10:00:01.000Z' })),
      view(reviewLine({ ts: '2026-09-27T10:00:00.000Z' })),
    ]);
    expect(rows.map((r) => r.mcp)).toEqual(['notion', 'stripe']);
  });

  it('a change of the same connector in between ends the run', () => {
    const rows = collapseDuplicates([
      view(reviewLine()),
      view(changeLine()),
      view(reviewLine()),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('anything that differs keeps both: findings, catalog hash', () => {
    const base = view(reviewLine());
    expect(collapseDuplicates([base, view(reviewLine({ findings: [] }))])).toHaveLength(2);
    expect(collapseDuplicates([base, view(reviewLine({ snapshot: { before: null, after: 'sha256:other' } }))])).toHaveLength(2);
    expect(
      collapseDuplicates([base, view(reviewLine({ findings: [{ ...FINDING, evidence: { ...FINDING.evidence, rule: 'prefer_over_other_tools' } }] }))]),
    ).toHaveLength(2);
  });

  it('a re-review after a version bump that states the same findings shows once, and keeps the mark', async () => {
    // The v2 review, already marked reviewed; then the same catalog re-reviewed
    // once injection_marker went to v3: same findings, new versions.
    const v2 = reviewLine({ id: 'RV2', ts: '2026-09-27T10:00:00.000Z' });
    const v3 = reviewLine({
      id: 'RV3',
      ts: '2026-10-04T10:00:00.000Z',
      reviewed_with: { ...REVIEWED_WITH, injection_marker: 3 },
      findings: [{ ...FINDING, rule_version: 3 }],
    });
    const marker = {
      v: 1, id: 'M2', ts: '2026-09-28T09:00:00.000Z', session: 'desktop',
      type: REVIEW_STATUS_CHANGED_TYPE, target_event_id: 'RV2', from: 'unreviewed', to: 'reviewed',
    };
    const rows = await readConnectorChanges(await dirWith(v2, marker, v3));
    expect(rows.map((r) => [r.event_id, r.review_status])).toEqual([['RV2', 'reviewed']]);
  });

  it('a re-review that finds something NEW is its own row', () => {
    const v3 = view(reviewLine({
      reviewed_with: { ...REVIEWED_WITH, injection_marker: 3 },
      findings: [{ ...FINDING, rule_version: 3 }, { ...FINDING, rule_version: 3, evidence: { ...FINDING.evidence, target: 'reply' } }],
    }));
    expect(collapseDuplicates([v3, view(reviewLine())])).toHaveLength(2);
  });

  it('change lines are never collapsed, even identical ones', () => {
    expect(collapseDuplicates([view(changeLine()), view(changeLine())])).toHaveLength(2);
  });
});
