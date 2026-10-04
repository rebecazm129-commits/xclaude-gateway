// Holdout v1 as a regression test (EVALUATION.md).
//
// 54 cases written independently, after the V1 rules were frozen in bdd93e5,
// kept verbatim in fixtures/holdout-v1.json. Each case becomes one tool
// definition with the text in the field it names, and goes through the REAL
// catalog review — the seed of observeSection on an empty baseline — not
// through a copy of the regular expressions.
//
// Measured on V1.0 (injection_marker v2): 19/24 positives detected, each by its
// own phrase; 0/30 negatives flagged.
//
// V1.1 (injection_marker v3) closed the five V1.0 misses by widening the
// mechanism behind each one, and those five cases were its DEVELOPMENT
// examples. So this holdout is spent: it is a regression set, and 24/24 here
// is not a measure of detection. V1.1 is not yet evaluated (EVALUATION.md).
//
// A case that stops being detected is a regression; a new miss goes into
// KNOWN_GAPS, asserted as a miss, so a later fix is recorded instead of
// passing in silence.

import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeSection } from '../src/detection/manifest-sections.js';

interface HoldoutCase {
  id: string;
  kind: 'positive' | 'negative';
  target: 'P1' | 'P3' | 'P4' | 'P5' | null;
  field: string;
  text: unknown;
  note: string;
}

const CASES: HoldoutCase[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/holdout-v1.json', import.meta.url)), 'utf8'),
);

/** The phrase each pattern records as the finding's rule. */
const RULE_OF: Record<'P1' | 'P3' | 'P4' | 'P5', string> = {
  P1: 'ignore_other_tools',
  P3: 'prefer_over_other_tools',
  P4: 'precede_all_tools',
  P5: 'displace_named_tools',
};

/** Misses under the current rules. Empty since V1.1: the five V1.0 misses
 *  (EVALUATION.md, "Known misses") were POS-P1-02, POS-P1-05, POS-P3-04,
 *  POS-P3-05 and POS-P5-05. */
const KNOWN_GAPS: Record<string, string> = {};

/** A neutral tool with the case's text in the field the case names. */
function toolFor(c: HoldoutCase): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    name: 'holdout_tool',
    description: 'Neutral tool.',
    inputSchema: { type: 'object', properties: {} },
  };
  if (c.field === 'name' || c.field === 'description') {
    tool[c.field] = c.text;
    return tool;
  }
  const parts = c.field.split('.');
  let node = tool as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
    if (parts[i - 1] === 'properties' && node['type'] === undefined) node['type'] = 'object';
  }
  const leaf = parts[parts.length - 1]!;
  node[leaf] = leaf === 'enum' ? (Array.isArray(c.text) ? c.text : [c.text]) : c.text;
  return tool;
}

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-holdout-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

let n = 0;
/** The rules the real seed review raised for this case. */
function review(c: HoldoutCase): { rule_id: string; rule?: string }[] {
  const baseDir = join(tmpDir, `case-${(n += 1)}`);
  mkdirSync(baseDir, { recursive: true });
  const out = observeSection(
    { baseDir, appVersion: 'holdout', now: () => '2026-09-28T10:00:00.000Z' },
    'holdout',
    'tools',
    { tools: [toolFor(c)] },
  );
  return (out.review?.findings ?? []).map((f) => ({
    rule_id: f.rule_id,
    ...(f.evidence.rule !== undefined ? { rule: f.evidence.rule } : {}),
  }));
}

describe('holdout v1 — fixture shape', () => {
  it('54 cases: 24 positives (6 per pattern) and 30 negatives', () => {
    expect(CASES).toHaveLength(54);
    expect(CASES.filter((c) => c.kind === 'negative')).toHaveLength(30);
    for (const p of ['P1', 'P3', 'P4', 'P5'] as const) {
      expect(CASES.filter((c) => c.kind === 'positive' && c.target === p)).toHaveLength(6);
    }
    for (const id of Object.keys(KNOWN_GAPS)) expect(CASES.some((c) => c.id === id)).toBe(true);
  });
});

describe('holdout v1 — positives', () => {
  for (const c of CASES.filter((x) => x.kind === 'positive')) {
    const gap = KNOWN_GAPS[c.id];
    if (gap === undefined) {
      it(`${c.id} (${c.field}) is detected as ${c.target}`, () => {
        expect(review(c)).toEqual([{ rule_id: 'injection_marker', rule: RULE_OF[c.target!] }]);
      });
    } else {
      it(`${c.id} (${c.field}) is a known gap — ${gap}`, () => {
        expect(review(c), `${c.id} now passes: move it out of KNOWN_GAPS and update EVALUATION.md`).toEqual([]);
      });
    }
  }
});

describe('holdout v1 — negatives and out-of-scope', () => {
  for (const c of CASES.filter((x) => x.kind === 'negative')) {
    it(`${c.id} (${c.field}) raises nothing`, () => {
      expect(review(c)).toEqual([]);
    });
  }
});

describe('holdout v1 — totals as a regression set (not a measure since V1.1)', () => {
  it('24/24 positives, 0/30 negatives', () => {
    const detected = CASES.filter((c) => c.kind === 'positive' && review(c).length > 0).length;
    const flagged = CASES.filter((c) => c.kind === 'negative' && review(c).length > 0).length;
    expect([detected, flagged]).toEqual([24 - Object.keys(KNOWN_GAPS).length, 0]);
  });
});
