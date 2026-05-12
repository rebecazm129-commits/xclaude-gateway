import { describe, expect, it } from 'vitest';

import { LineSplitter } from '../src/splitter.js';

describe('LineSplitter', () => {
  it('emits all complete lines in a single chunk with trailing newline', () => {
    const s = new LineSplitter();
    expect(s.feed(Buffer.from('alpha\nbeta\n', 'utf8'))).toEqual(['alpha', 'beta']);
    expect(s.incompleteBytes()).toBe(0);
  });

  it('skips empty lines (\\n\\n produces no extra frame)', () => {
    const s = new LineSplitter();
    expect(s.feed(Buffer.from('alpha\n\nbeta\n', 'utf8'))).toEqual(['alpha', 'beta']);
  });

  it('buffers incomplete trailing line until newline arrives (line spans chunks)', () => {
    const s = new LineSplitter();
    expect(s.feed(Buffer.from('alpha\nincomp', 'utf8'))).toEqual(['alpha']);
    expect(s.incompleteBytes()).toBe(6); // "incomp" → 6 bytes
    expect(s.feed(Buffer.from('lete\nbeta\n', 'utf8'))).toEqual(['incomplete', 'beta']);
    expect(s.incompleteBytes()).toBe(0);
  });

  it('handles multibyte UTF-8 codepoint split across two chunks', () => {
    // 'ñ' = 0xC3 0xB1 in UTF-8. First chunk has only the leading byte.
    const s = new LineSplitter();
    expect(s.feed(Buffer.from([0xc3]))).toEqual([]);
    expect(s.incompleteBytes()).toBe(0); // TextDecoder buffers internally; no string yet
    expect(s.feed(Buffer.from([0xb1, 0x0a]))).toEqual(['ñ']);
  });

  it('reports incompleteBytes as utf-8 byte count, not character count', () => {
    const s = new LineSplitter();
    s.feed(Buffer.from('café', 'utf8')); // 'é' is 2 bytes → total 5
    expect(s.incompleteBytes()).toBe(5);
  });

  it('treats a lone newline as an empty line (skipped, no frame)', () => {
    const s = new LineSplitter();
    expect(s.feed(Buffer.from('\n', 'utf8'))).toEqual([]);
    expect(s.incompleteBytes()).toBe(0);
  });
});
