// Corpus fixture contract. Data lives in JSON next to this file; this module
// is only the shape plus the loader.
//
// `malicious` is the TRUTH of the case and is independent of what the detector
// does. `status` is what the detector does TODAY. Keeping them apart is the
// point of the corpus: a case can be malicious and uncovered without anything
// turning green by omission.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Severity } from '@xcg/shared';
import type { ToolDef } from '../../src/detection/manifest.js';

export type CoverageStatus = 'covered' | 'gap' | 'not_observable';
export type Split = 'dev' | 'holdout';

export interface Fixture {
  id: string;
  title: string;
  provenance: {
    /** synthetic: written for this corpus. trail-local: derived from the
     *  operator's own trail, never committed. */
    source: 'synthetic' | 'published-research' | 'trail-local';
    url: string | null;
    licence: string;
  };
  /** Attack family. The dev/holdout split is BY FAMILY: tuning the detector to
   *  one case would otherwise make its twin in the holdout pass for free. */
  technique: string;
  observable: 'manifest' | 'traffic' | 'out_of_band';
  mapping?: { owasp_mcp?: string; mitre_atlas?: string };
  baseline?: { tools: ToolDef[] };
  changed?: { tools: ToolDef[] };
  /** Ground truth, not a detector expectation. */
  malicious: boolean;
  expected_changes: string[];
  expected_findings: string[];
  severity: { minimum?: Severity | null; maximum?: Severity | null };
  status: CoverageStatus;
  split?: Split;
  notes: string;
  /** out_of_scope only: which detector could see this, if any. */
  would_be_seen_by?: string;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));

function load(file: string): Fixture[] {
  const path = join(HERE, file);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture[];
}

export const ATTACK: Fixture[] = load('attack/cases.json');
export const NEGATIVES: Fixture[] = load('negatives/cases.json');
export const OUT_OF_SCOPE: Fixture[] = load('out_of_scope/cases.json');

/** Real negatives derived from the operator's own trail. They carry provider
 *  tool names, descriptions and schemas tied to a specific installation, so
 *  they NEVER live in the repo: point XCG_CORPUS_LOCAL at a directory holding
 *  cases.json and they join the run. Absent → the synthetic set runs alone,
 *  which is what CI does. */
export function loadLocalNegatives(): Fixture[] {
  const dir = process.env['XCG_CORPUS_LOCAL'];
  if (dir === undefined || dir === '' || !existsSync(dir)) return [];
  const out: Fixture[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture[]));
    } catch {
      // A malformed local file must never fail the repo's own suite.
    }
  }
  return out;
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const atLeast = (actual: Severity, min: Severity): boolean => RANK[actual] >= RANK[min];
export const atMost = (actual: Severity, max: Severity): boolean => RANK[actual] <= RANK[max];
