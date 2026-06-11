import { describe, expect, it } from 'vitest';

import { mapGroupsToFindings } from '../../../src/detection/ner/worker-pure.js';

describe('mapGroupsToFindings', () => {
  // Forma grouped (aggregation_strategy:'simple'): entity_group ya limpio,
  // score agregado, word fusionada. Sin index ni start/end (q8, spike 11/06).
  const sample = [
    { entity_group: 'PER', score: 0.99, word: 'Alice Smith' },
    { entity_group: 'LOC', score: 0.6, word: 'NY' },
    { entity_group: 'ORG', score: 0.4, word: 'maybe' },
  ];

  it('keeps groups with score strictly above threshold', () => {
    expect(mapGroupsToFindings(sample, 0.5)).toEqual([
      { type: 'PER' },
      { type: 'LOC' },
    ]);
  });

  it('filters groups at the exact threshold (strict >, not >=)', () => {
    // score 0.6 con threshold 0.6 debe filtrarse.
    expect(mapGroupsToFindings(sample, 0.6)).toEqual([{ type: 'PER' }]);
  });

  it('applies the production threshold 0.5: a 0.5 group is filtered out', () => {
    const atBoundary = [{ entity_group: 'PER', score: 0.5, word: 'X' }];
    expect(mapGroupsToFindings(atBoundary, 0.5)).toEqual([]);
  });

  it('discards a real sub-threshold group from the spike (score 0.27)', () => {
    // spike 11/06 b1: el grouped emitio {entity_group:'LOC', score:0.27,
    // word:'de María García'} que el filtro estricto debe descartar.
    const withSubThreshold = [
      { entity_group: 'LOC', score: 0.27, word: 'de María García' },
      { entity_group: 'LOC', score: 0.98, word: 'Sevilla' },
    ];
    expect(mapGroupsToFindings(withSubThreshold, 0.5)).toEqual([
      { type: 'LOC' },
    ]);
  });

  it('returns empty when all groups are below threshold', () => {
    expect(mapGroupsToFindings(sample, 0.999)).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(mapGroupsToFindings([], 0.5)).toEqual([]);
  });

  it('produces findings without a location field', () => {
    const result = mapGroupsToFindings(sample, 0.5);
    for (const f of result) {
      expect('location' in f).toBe(false);
    }
  });
});
