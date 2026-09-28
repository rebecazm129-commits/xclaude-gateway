// The catalog review over the operator's real baselines, as a regression test.
//
// OPT-IN, like heuristics-replay: the input is one installation's manifests/v2
// directory, with provider tool names and descriptions. It never lives in the
// repo. Point XCG_REPLAY_MANIFESTS at that directory and this runs; absent, it
// skips, which is what CI does.
//
// What it pins: the one-time review of the connectors that already exist
// raises NOTHING on the real catalogs (361 tools across 10 commercial
// connectors on 27/09). A rule change that makes it noisy fails here first.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REVIEW_RULES, reviewToolSurfaces, type ToolDef } from '../src/detection/manifest.js';

const DIR = process.env['XCG_REPLAY_MANIFESTS'];
const isDev = (m: string): boolean =>
  m.startsWith('xcg') || m.includes('smoke') || ['f0verify', 'xclaude'].includes(m);

describe.skipIf(DIR === undefined)('catalog review over the real baselines', () => {
  it('raises no finding on any real catalog', () => {
    let tools = 0;
    const found: string[] = [];
    for (const f of readdirSync(DIR!).filter((x) => x.endsWith('.json'))) {
      const b = JSON.parse(readFileSync(join(DIR!, f), 'utf8'));
      if (typeof b.mcp !== 'string' || isDev(b.mcp)) continue;
      const items = ((b.sections?.tools?.snapshot?.items ?? []) as ToolDef[]).filter((t) => typeof t?.name === 'string');
      tools += items.length;
      for (const x of reviewToolSurfaces(items, new Set(REVIEW_RULES))) {
        found.push(`${b.mcp}/${x.evidence.target}: ${x.rule_id} ${x.evidence.rule ?? ''}`);
      }
    }
    expect(tools).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});
