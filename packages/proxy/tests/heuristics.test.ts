// inserted_text_single_tool v1.
//
// The two halves under test are the two the measurements forced: inserted text
// rather than growth, and one item rather than a percentage of the catalogue.

import { describe, expect, it } from 'vitest';

import {
  HEURISTIC_ID,
  HEURISTIC_VERSION,
  INSERTED_TEXT_MIN,
  attentionFor,
  descriptionsOf,
  insertedChars,
} from '../src/detection/heuristics.js';

const words = (n: number, w = 'documentation'): string =>
  Array.from({ length: n }, () => w).join(' ');

describe('insertedChars', () => {
  it('identical text inserts nothing', () => {
    expect(insertedChars('same words here', 'same words here')).toBe(0);
  });

  it('appended text counts', () => {
    expect(insertedChars('a b', 'a b c')).toBe(2); // ' c'
  });

  it('text inserted in the MIDDLE counts, though net growth is the same', () => {
    const mid = insertedChars('a b c', 'a NEW b c');
    const end = insertedChars('a b c', 'a b c NEW');
    expect(mid).toBe(end);
  });

  it('a same-size rewrite inserts its whole new body', () => {
    // The case no growth threshold can see: length held constant on purpose.
    const before = words(20, 'alpha');
    const after = words(20, 'bravo');
    expect(after.length).toBe(before.length);
    expect(insertedChars(before, after)).toBeGreaterThan(before.length / 2);
  });

  it('a SHRINKING rewrite still reports what was inserted', () => {
    const before = `${words(40, 'alpha')} keep`;
    const after = `keep ${words(5, 'bravo')}`;
    expect(after.length).toBeLessThan(before.length);
    expect(insertedChars(before, after)).toBeGreaterThan(0);
  });

  it('removal alone inserts nothing', () => {
    expect(insertedChars('a b c d', 'a b')).toBe(0);
  });

  it('an empty previous description inserts the whole new one', () => {
    expect(insertedChars('', 'hello there')).toBe('hello there'.length);
  });

  it('is word-level, so a shared prefix is not re-counted', () => {
    const base = words(200);
    expect(insertedChars(base, `${base} plus this tail`)).toBe(' plus this tail'.length);
  });
});

describe('attentionFor', () => {
  const desc = (m: Record<string, string>): Map<string, string> => new Map(Object.entries(m));
  const base = words(120); // ~1500 chars, production-sized

  it('a long insertion on ONE existing item recommends review', () => {
    const a = attentionFor({
      affectedItems: 1,
      before: desc({ search: base }),
      after: desc({ search: `${base} ${words(8, 'instruction')}` }),
    });
    expect(a.level).toBe('review_recommended');
    if (a.level !== 'review_recommended') throw new Error('unreachable');
    expect(a.heuristic_id).toBe(HEURISTIC_ID);
    expect(a.heuristic_version).toBe(HEURISTIC_VERSION);
  });

  it('the same insertion across TWO items does not — that is a release', () => {
    const a = attentionFor({
      affectedItems: 2,
      before: desc({ search: base, fetch: base }),
      after: desc({ search: `${base} ${words(8, 'instruction')}`, fetch: base }),
    });
    expect(a).toEqual({ level: 'normal' });
  });

  it('an insertion below the threshold does not', () => {
    const short = 'x'.repeat(INSERTED_TEXT_MIN - 10);
    const a = attentionFor({
      affectedItems: 1,
      before: desc({ search: base }),
      after: desc({ search: `${base} ${short}` }),
    });
    expect(a).toEqual({ level: 'normal' });
  });

  it('exactly the threshold does', () => {
    const exact = 'x'.repeat(INSERTED_TEXT_MIN);
    const a = attentionFor({
      affectedItems: 1,
      before: desc({ search: base }),
      after: desc({ search: `${base} ${exact}` }),
    });
    expect(a.level).toBe('review_recommended');
  });

  it('a BRAND-NEW item never trips it, however long its description', () => {
    // Otherwise every tool a vendor adds would read as an insertion of its
    // whole body. New items are the rules' question, not this one's.
    const a = attentionFor({
      affectedItems: 1,
      before: desc({}),
      after: desc({ brandNew: words(400) }),
    });
    expect(a).toEqual({ level: 'normal' });
  });

  it('a removal alone never trips it', () => {
    const a = attentionFor({
      affectedItems: 1,
      before: desc({ gone: base }),
      after: desc({}),
    });
    expect(a).toEqual({ level: 'normal' });
  });

  it('raising attention always names the heuristic and its version', () => {
    const a = attentionFor({
      affectedItems: 1,
      before: desc({ s: base }),
      after: desc({ s: `${base} ${words(20, 'payload')}` }),
    });
    expect(a).toMatchObject({
      level: 'review_recommended',
      heuristic_id: 'inserted_text_single_tool',
      heuristic_version: 1,
    });
  });
});

describe('descriptionsOf', () => {
  it('reads the stored { items } snapshot shape', () => {
    const m = descriptionsOf({ items: [{ name: 'a', description: 'x' }, { name: 'b' }] });
    expect(m.get('a')).toBe('x');
    expect(m.get('b')).toBe(''); // present, undocumented
  });

  it('reads a bare array too', () => {
    expect(descriptionsOf([{ name: 'a', description: 'x' }]).get('a')).toBe('x');
  });

  it('keys resources by uri and templates by uriTemplate', () => {
    expect(descriptionsOf({ items: [{ uri: 'file:///a', description: 'd' }] }).get('file:///a')).toBe('d');
    expect(
      descriptionsOf({ items: [{ uriTemplate: 'file:///{p}', description: 'd' }] }).get('file:///{p}'),
    ).toBe('d');
  });

  it('a shape it does not recognise is empty, not an error', () => {
    for (const v of [null, 42, 'x', {}, { items: 'no' }]) {
      expect(descriptionsOf(v).size).toBe(0);
    }
  });
});
