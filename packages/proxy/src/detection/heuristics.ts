// Heuristics that raise attention. NOT rules.
//
// A rule states something it can prove about the surface: this parameter name
// is sensitive, this path is credential-shaped, these codepoints are invisible.
// A heuristic states a suspicion about the SHAPE of an edit, and it is right
// only on average. Keeping the two apart is why findings and attention are
// separate fields: a heuristic must never be able to manufacture a finding.
//
// WHY INSERTED TEXT AND NOT GROWTH. Net growth is blind to the two edits that
// matter most. A rewrite that swaps documentation for an instruction can hold
// the length constant — a rug pull has no reason to grow a description when it
// can replace one — and a payload dropped mid-paragraph displaces text so the
// net moves barely at all. Measured on the corpus: one case grows by 29
// characters while inserting 809, and another SHRINKS by 163 while inserting
// 206. Both are invisible to any threshold on growth, with or without a sign.
//
// WHY ONE TOOL. A vendor re-documenting its catalogue touches many tools at
// once; an attacker adding an instruction touches one. The scope is what
// separates the two, and it is absolute rather than a percentage on purpose:
// apollo went from 34 tools to 74 in the corpus window, so a 10% scope would
// have meant three tools in June and seven in September — the same edit
// changing verdict with the calendar.
//
// THE THRESHOLD IS THE WEAK PART, and this is the place it is written down.
// 60 characters is the minimum poison length in the synthetic corpus, which
// means the corpus cannot be evidence that 60 is right — it was authored, not
// observed. What 60 is calibrated against is the production side: 51 events in
// Needs review over 15.5 weeks, 3.3 a week. Recalibrating with real data from
// more than one installation is expected, and it goes through
// HEURISTIC_VERSION so every past verdict stays interpretable.

import type { Attention } from '@xcg/shared';

export const HEURISTIC_ID = 'inserted_text_single_tool';
export const HEURISTIC_VERSION = 1;

/** Characters of inserted text that make one tool worth a look. */
export const INSERTED_TEXT_MIN = 60;

/** How many items of a section may move before this stops being a targeted
 *  edit and starts being a release. */
export const MAX_AFFECTED_ITEMS = 1;

/** Above this the word-level table is not worth building; the answer at that
 *  size is never in doubt anyway. */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * Characters present in `after` that are not part of the longest common word
 * subsequence with `before`.
 *
 * Word-level rather than character-level on purpose: a character diff of two
 * prose paragraphs finds common letters everywhere and under-reports a real
 * insertion, while a word diff tracks what a reader would call added text.
 */
export function insertedChars(before: string, after: string): number {
  if (before === after) return 0;
  if (before === '') return after.length;
  const A = before.split(/(\s+)/);
  const B = after.split(/(\s+)/);
  const n = A.length;
  const m = B.length;
  // Degrade to net growth rather than spend unbounded time on a pathological
  // pair: a description that large is already its own signal.
  if (n * m > LCS_CELL_BUDGET) return Math.max(0, after.length - before.length);

  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let inserted = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      inserted += B[j]!.length;
      j++;
    }
  }
  while (j < m) {
    inserted += B[j]!.length;
    j++;
  }
  return inserted;
}

const NORMAL: Attention = { level: 'normal' };
const RECOMMENDED: Attention = {
  level: 'review_recommended',
  heuristic_id: HEURISTIC_ID,
  heuristic_version: HEURISTIC_VERSION,
};

/** name → description, from a stored v2 snapshot or a live collection. */
export function descriptionsOf(snapshot: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (snapshot === null || typeof snapshot !== 'object') return out;
  const items = Array.isArray(snapshot)
    ? snapshot
    : (snapshot as Record<string, unknown>)['items'];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = rec['name'] ?? rec['uri'] ?? rec['uriTemplate'];
    if (typeof name !== 'string') continue;
    out.set(name, typeof rec['description'] === 'string' ? rec['description'] : '');
  }
  return out;
}

export interface AttentionInput {
  /** How many items of the section moved in this change. */
  affectedItems: number;
  before: Map<string, string>;
  after: Map<string, string>;
}

/**
 * Whether a human should look at this change.
 *
 * Only an item that EXISTED before counts: a brand-new tool has no previous
 * description, so "inserted text" would be its whole body and every addition
 * would trip. New tools are the rules' problem, not this one's.
 */
export function attentionFor(input: AttentionInput): Attention {
  if (input.affectedItems > MAX_AFFECTED_ITEMS) return NORMAL;
  for (const [name, after] of input.after) {
    const before = input.before.get(name);
    if (before === undefined) continue; // new item: not this heuristic's question
    if (insertedChars(before, after) >= INSERTED_TEXT_MIN) return RECOMMENDED;
  }
  return NORMAL;
}
