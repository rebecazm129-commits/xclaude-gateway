// The word diff, shared by the heuristic that measures an edit and the panel
// that shows it. These pin the properties both rely on.

import { describe, expect, it } from 'vitest';

import {
  insertedChars,
  removedChars,
  toUnifiedText,
  tooLargeToDiff,
  wordDiff,
} from '../src/word-diff.js';

const join = (before: string, after: string): string =>
  wordDiff(before, after)
    .filter((s) => s.kind !== 'removed')
    .map((s) => s.text)
    .join('');

describe('wordDiff reconstructs its inputs exactly', () => {
  // The property the highlight depends on: if the segments did not concatenate
  // back to the original, the panel would be showing text the connector never
  // sent.
  it.each([
    ['a b c', 'a b c'],
    ['a b c', 'a X b c'],
    ['a b c', 'a c'],
    ['', 'all new'],
    ['all gone', ''],
    ['one   spaced  out', 'one spaced out'],
  ])('%o → %o', (before, after) => {
    expect(join(before, after)).toBe(after);
    const dropped = wordDiff(before, after)
      .filter((s) => s.kind !== 'added')
      .map((s) => s.text)
      .join('');
    expect(dropped).toBe(before);
  });
});

describe('counts', () => {
  it('an insertion in the middle counts the same as one at the end', () => {
    expect(insertedChars('a b c', 'a NEW b c')).toBe(insertedChars('a b c', 'a b c NEW'));
  });

  it('a same-size rewrite reports what was inserted, not the net zero', () => {
    const before = 'alpha alpha alpha alpha';
    const after = 'bravo bravo bravo bravo';
    expect(after.length).toBe(before.length);
    expect(insertedChars(before, after)).toBeGreaterThan(0);
  });

  it('a shrinking rewrite still reports its insertion', () => {
    expect(insertedChars('keep one two three four five', 'keep NEWWORD')).toBeGreaterThan(0);
  });

  it('a pure deletion inserts nothing and removes something', () => {
    expect(insertedChars('a b c d', 'a b')).toBe(0);
    expect(removedChars('a b c d', 'a b')).toBeGreaterThan(0);
  });

  it('adjacent segments of a kind are merged, so counting is not order-dependent', () => {
    const segs = wordDiff('a b', 'a X Y Z b');
    expect(segs.filter((s) => s.kind === 'added')).toHaveLength(1);
  });
});

describe('the oversized fallback', () => {
  // The heuristic's 60-character threshold was calibrated with net growth as
  // the fallback. Answering "everything is inserted" there would move a
  // calibrated number as a side effect of an optimisation.
  const huge = (word: string, n: number): string => Array.from({ length: n }, () => word).join(' ');

  it('a pathological pair is reported as too large', () => {
    expect(tooLargeToDiff(huge('alpha', 3000), huge('bravo', 3000))).toBe(true);
  });

  it('and falls back to NET GROWTH, a lower bound, not to the whole length', () => {
    const before = huge('alpha', 3000);
    const after = huge('bravo', 3000) + ' tail';
    expect(insertedChars(before, after)).toBe(after.length - before.length);
    expect(insertedChars(before, after)).toBeLessThan(after.length);
  });

  it('ordinary descriptions are never oversized', () => {
    expect(tooLargeToDiff('a '.repeat(500), 'a '.repeat(500) + 'x')).toBe(false);
  });
});

describe('toUnifiedText', () => {
  it('marks added and removed, and names the target when given one', () => {
    const out = toUnifiedText('keep gone', 'keep added', 'search');
    expect(out).toContain('--- search (before)');
    expect(out).toContain('+ added');
    expect(out).toContain('- gone');
  });
});
