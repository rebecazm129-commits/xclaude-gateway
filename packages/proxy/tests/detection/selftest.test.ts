// Regression tests for the self-test payload registry.
//
// Asserts that each EXAMPLE_PAYLOAD in getSelfTestPayloads() produces exactly
// its declared category and severity when run through DetectionEngine with the
// real ACTIVE_DETECTORS chain. Validates payload accuracy AND inter-detector
// isolation in a single pass: any cross-firing would make length !== 1.
//
// Also validates registry shape: total count, no duplicate categoryKey, and
// the canonical display order (severity desc + baseline last).

import { describe, it, expect } from 'vitest';

import { DetectionEngine } from '../../src/detection/engine.js';
import { ACTIVE_DETECTORS } from '../../src/detection/detectors/index.js';
import { getSelfTestPayloads } from '../../src/detection/selftest.js';
import { toEchoToolCallParams } from '@xcg/shared';
import type { McpRequestEnvelope, SelfTestExample } from '../../src/detection/types.js';

function envelopeFor(example: SelfTestExample): McpRequestEnvelope {
  return {
    payload: toEchoToolCallParams(example),
    mcp: 'test-mcp',
    method: example.method,
    direction: 'client_to_server',
    sessionId: '01HXSELFTESTTEST',
  };
}

describe('self-test registry', () => {
  const examples = getSelfTestPayloads();
  const engine = new DetectionEngine(ACTIVE_DETECTORS);

  describe('per-example detection', () => {
    for (const example of examples) {
      it(`${example.categoryKey} fires exactly once with the expected severity`, () => {
        const envelope = envelopeFor(example);
        const out = engine.detect(envelope);

        expect(out).toHaveLength(1);
        expect(out[0]?.category).toBe(example.categoryKey);
        expect(out[0]?.severity).toBe(example.expectedSeverity);
      });
    }
  });

  describe('registry shape', () => {
    it('contains exactly six examples', () => {
      expect(examples).toHaveLength(6);
    });

    it('has no duplicate categoryKey', () => {
      const keys = examples.map((e) => e.categoryKey);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it('lists severities in descending order followed by the baseline last', () => {
      const severityRank: Record<string, number> = {
        critical: 4,
        high: 3,
        medium: 2,
        low: 1,
      };

      // Last entry must be the baseline (tool_call_allowed / low).
      const last = examples[examples.length - 1];
      expect(last?.categoryKey).toBe('tool_call_allowed');
      expect(last?.expectedSeverity).toBe('low');

      // Detector entries (all but the last) must be in non-increasing severity order.
      const detectorEntries = examples.slice(0, -1);
      for (let i = 1; i < detectorEntries.length; i++) {
        const prevRank = severityRank[detectorEntries[i - 1]!.expectedSeverity];
        const currRank = severityRank[detectorEntries[i]!.expectedSeverity];
        expect(prevRank).toBeGreaterThanOrEqual(currRank!);
      }
    });
  });
});
