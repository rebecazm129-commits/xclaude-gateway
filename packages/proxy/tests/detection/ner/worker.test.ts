import { describe, expect, it } from 'vitest';

import {
  mapTokensToFindings,
  stripBio,
} from '../../../src/detection/ner/worker.js';

describe('stripBio', () => {
  it('strips B- prefix', () => {
    expect(stripBio('B-PER')).toBe('PER');
  });
  it('strips I- prefix', () => {
    expect(stripBio('I-LOC')).toBe('LOC');
  });
  it('leaves O unchanged', () => {
    expect(stripBio('O')).toBe('O');
  });
  it('leaves a label without BIO prefix unchanged', () => {
    expect(stripBio('SOMETHING')).toBe('SOMETHING');
  });
});

describe('mapTokensToFindings', () => {
  const sample = [
    { entity: 'B-PER', score: 0.99, index: 1, word: 'Alice' },
    { entity: 'I-PER', score: 0.98, index: 2, word: 'Smith' },
    { entity: 'B-LOC', score: 0.6, index: 5, word: 'NY' },
    { entity: 'O', score: 0.3, index: 6, word: 'maybe' },
  ];

  it('keeps tokens with score strictly above threshold', () => {
    expect(mapTokensToFindings(sample, 0.5)).toEqual([
      { type: 'PER' },
      { type: 'PER' },
      { type: 'LOC' },
    ]);
  });

  it('filters tokens at the exact threshold (strict >, not >=)', () => {
    // score 0.6 con threshold 0.6 debe filtrarse.
    expect(mapTokensToFindings(sample, 0.6)).toEqual([
      { type: 'PER' },
      { type: 'PER' },
    ]);
  });

  it('applies the production threshold 0.5: a 0.5 token is filtered out', () => {
    const atBoundary = [{ entity: 'B-PER', score: 0.5, index: 0, word: 'X' }];
    expect(mapTokensToFindings(atBoundary, 0.5)).toEqual([]);
  });

  it('returns empty when all tokens are below threshold', () => {
    expect(mapTokensToFindings(sample, 0.999)).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(mapTokensToFindings([], 0.5)).toEqual([]);
  });

  it('produces findings without a location field', () => {
    const result = mapTokensToFindings(sample, 0.5);
    for (const f of result) {
      expect('location' in f).toBe(false);
    }
  });
});
