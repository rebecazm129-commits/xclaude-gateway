// The production replay, as a regression test.
//
// OPT-IN, like the corpus's local negatives and for the same reason: the input
// is one operator's real trail, carrying provider tool names, descriptions and
// schemas tied to their installation. It never lives in the repo. Point
// XCG_REPLAY_TRAIL at a wrappers directory and this runs; absent, it skips,
// which is what CI does.
//
// What it pins is the number the threshold was chosen against. 60 characters
// on a single item was picked because it puts Needs review at 51 events over
// 15.5 weeks of this trail — 3.3 a week. If a change to insertedChars, to the
// scope, or to the threshold moves that number, this fails and someone has to
// decide on purpose rather than discover it in production.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { attentionFor, descriptionsOf } from '../src/detection/heuristics.js';
import { buildManifest, extractTools, reportChanges, toolDeltas } from '../src/detection/manifest.js';

const TRAIL = process.env['XCG_REPLAY_TRAIL'];
const RULES = new Set(['sensitive_param_added', 'sensitive_path_reference', 'injection_marker', 'hidden_characters']);

/** The operator's own dev/test connectors, excluded so the corpus is traffic. */
const isDev = (m: string): boolean =>
  m.startsWith('xcg') || m.includes('smoke') || m.includes('test') || ['f0verify', 'xclaude'].includes(m);

interface Replayed {
  needsReview: number;
  recommended: number;
  withFindings: number;
  transitions: number;
  weeks: number;
  peakWeek: number;
}

function replay(dir: string): Replayed {
  const rows: { ts: string; mcp: string; result: unknown }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (d['type'] !== 'mcp.response') continue;
      const mcp = typeof d['mcp'] === 'string' ? d['mcp'] : '';
      if (mcp === '' || isDev(mcp)) continue;
      const result = d['result'];
      if (result === null || typeof result !== 'object') continue;
      if (!Array.isArray((result as Record<string, unknown>)['tools'])) continue;
      rows.push({ ts: typeof d['ts'] === 'string' ? d['ts'] : '', mcp, result });
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const prevMan = new Map<string, ReturnType<typeof buildManifest>>();
  const prevTools = new Map<string, unknown[]>();
  const weeks = new Map<string, number>();
  let needsReview = 0;
  let recommended = 0;
  let withFindings = 0;
  let transitions = 0;
  let first = '';
  let last = '';

  for (const r of rows) {
    const tools = extractTools(r.result);
    const next = buildManifest(tools);
    const pm = prevMan.get(r.mcp);
    const pt = prevTools.get(r.mcp);
    prevMan.set(r.mcp, next);
    prevTools.set(r.mcp, tools);
    if (pm === undefined || pt === undefined || pm.hash === next.hash) continue;
    const report = reportChanges(pm, next, tools);
    if (report === null) continue;
    transitions += 1;
    if (first === '') first = r.ts;
    last = r.ts;

    const attention = attentionFor({
      affectedItems: toolDeltas(pm, next, tools).length,
      before: descriptionsOf(pt),
      after: descriptionsOf(tools),
    });
    const hasFindings = report.findings.some((f) => RULES.has(f.rule_id));
    if (hasFindings) withFindings += 1;
    if (attention.level === 'review_recommended') recommended += 1;
    if (hasFindings || attention.level === 'review_recommended') {
      needsReview += 1;
      const d = new Date(r.ts);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      const key = d.toISOString().slice(0, 10);
      weeks.set(key, (weeks.get(key) ?? 0) + 1);
    }
  }

  const span = (Date.parse(last) - Date.parse(first)) / (7 * 86_400_000);
  return {
    needsReview,
    recommended,
    withFindings,
    transitions,
    weeks: span,
    peakWeek: weeks.size > 0 ? Math.max(...weeks.values()) : 0,
  };
}

describe.skipIf(TRAIL === undefined || TRAIL === '')('production replay (XCG_REPLAY_TRAIL)', () => {
  // Computed lazily: describe.skipIf still EVALUATES this body at collection
  // time, so replaying here would read a directory that is not there in CI.
  let memo: Replayed | null = null;
  const out = (): Replayed => (memo ??= replay(TRAIL ?? ''));

  it('reports what it measured', () => {
    console.log(
      `\nreplay: ${out().transitions} transitions over ${out().weeks.toFixed(1)} weeks` +
        `\n  needs review: ${out().needsReview} (${(out().needsReview / out().weeks).toFixed(1)}/week, peak ${out().peakWeek})` +
        `\n  with findings: ${out().withFindings}   review_recommended: ${out().recommended}\n`,
    );
    expect(out().transitions).toBeGreaterThan(0);
  });

  it('Needs review stays at 51 — not one more', () => {
    // The number the threshold was calibrated against. Moving it is a
    // decision, not a side effect.
    expect(out().needsReview).toBe(51);
  });

  it('the rules account for 20 and the heuristic adds 31, with no overlap', () => {
    // The two mechanisms turn out to be disjoint on this trail: the edits a
    // rule can prove something about are not the ones the heuristic suspects.
    expect(out().withFindings).toBe(20);
    expect(out().recommended).toBe(31);
    expect(out().withFindings + out().recommended).toBe(out().needsReview);
  });

  it('stays inside the weekly budget the design set', () => {
    expect(out().needsReview / out().weeks).toBeLessThanOrEqual(3.5);
  });
});
