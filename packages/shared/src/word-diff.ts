// Word-level diff, shared by the heuristic that MEASURES an edit and the panel
// that SHOWS it.
//
// One implementation on purpose. The heuristic says "212 characters were
// inserted" and the panel highlights which ones; if those two disagreed, the
// product would be flagging a change on one measurement and explaining it with
// another, and nobody could tell which was wrong.
//
// Word-level rather than character-level: a character diff of two prose
// paragraphs finds common letters everywhere and under-reports a real
// insertion. Splitting on whitespace RUNS (kept as tokens) means the
// reconstruction is exact — concatenating every segment gives back the input.

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

/** Above this the table is not worth building; the answer at that size is
 *  never in doubt anyway. */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * The segments turning `before` into `after`, in reading order.
 *
 * On a pathological pair (two very long, very different texts) it degrades to
 * a single removed + added pair rather than spending unbounded time: a
 * description that large is already its own signal.
 */
export function wordDiff(before: string, after: string): DiffSegment[] {
  if (before === after) return before === '' ? [] : [{ kind: 'same', text: before }];
  if (before === '') return [{ kind: 'added', text: after }];
  if (after === '') return [{ kind: 'removed', text: before }];

  const A = before.split(/(\s+)/);
  const B = after.split(/(\s+)/);
  const n = A.length;
  const m = B.length;
  if (n * m > LCS_CELL_BUDGET) {
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  }

  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }

  const out: DiffSegment[] = [];
  // Adjacent segments of the same kind are merged as they are produced, so a
  // consumer never has to stitch "added" runs back together to count or render
  // them.
  const push = (kind: DiffKind, text: string): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('removed', A[i]!);
      i++;
    } else {
      push('added', B[j]!);
      j++;
    }
  }
  while (i < n) {
    push('removed', A[i]!);
    i++;
  }
  while (j < m) {
    push('added', B[j]!);
    j++;
  }
  return out;
}

/** Whether a pair is too big to diff. Exposed because the two consumers have
 *  to degrade DIFFERENTLY and both need to know. */
export function tooLargeToDiff(before: string, after: string): boolean {
  if (before === after || before === '' || after === '') return false;
  return before.split(/(\s+)/).length * after.split(/(\s+)/).length > LCS_CELL_BUDGET;
}

/**
 * Characters of inserted text. What the heuristic thresholds on.
 *
 * On a pair too large to diff it falls back to NET GROWTH, not to the whole
 * length of `after`. That is a lower bound rather than an upper one, and it is
 * deliberate: the 60-character threshold was calibrated against this exact
 * behaviour over four months of production, and answering "everything is
 * inserted" there would move a calibrated number as a side effect of an
 * optimisation. Caught by the replay test, which went 51 → 52 the first time
 * this was written the other way.
 */
export function insertedChars(before: string, after: string): number {
  if (tooLargeToDiff(before, after)) return Math.max(0, after.length - before.length);
  let total = 0;
  for (const seg of wordDiff(before, after)) {
    if (seg.kind === 'added') total += seg.text.length;
  }
  return total;
}

/** Characters of removed text, for the panel's summary line. */
export function removedChars(before: string, after: string): number {
  if (tooLargeToDiff(before, after)) return Math.max(0, before.length - after.length);
  let total = 0;
  for (const seg of wordDiff(before, after)) {
    if (seg.kind === 'removed') total += seg.text.length;
  }
  return total;
}

/** A unified-diff-ish plain text rendering, for the clipboard. Not a real
 *  unified diff with hunks: the input is one paragraph, so context lines would
 *  be the whole thing. */
export function toUnifiedText(before: string, after: string, label?: string): string {
  const head = label === undefined ? '' : `--- ${label} (before)\n+++ ${label} (after)\n\n`;
  const lines: string[] = [];
  for (const seg of wordDiff(before, after)) {
    if (seg.text.trim() === '') continue;
    const mark = seg.kind === 'added' ? '+' : seg.kind === 'removed' ? '-' : ' ';
    lines.push(`${mark} ${seg.text.trim()}`);
  }
  return head + lines.join('\n') + '\n';
}
