// DetectionEngine — runs an ordered chain of detectors and emits the baseline
// tool_call_allowed when none fire. No real detectors live here; those land
// in Phases 1 (wrapper integration) and 3 (regex detectors).

import type { Detector, DetectorInput, DetectorOutput } from './types.js';

function baselineToolCallAllowed(): DetectorOutput {
  return {
    category: 'tool_call_allowed',
    severity: 'low',
    findings: [],
  };
}

export function runDetectors(
  input: DetectorInput,
  detectors: readonly Detector[],
): DetectorOutput[] {
  const out: DetectorOutput[] = [];
  for (const detector of detectors) {
    const result = detector(input);
    if (result !== null) out.push(result);
  }
  return out;
}

export function emitDetections(
  input: DetectorInput,
  detectors: readonly Detector[],
): DetectorOutput[] {
  const results = runDetectors(input, detectors);
  if (results.length === 0) return [baselineToolCallAllowed()];
  return results;
}

export class DetectionEngine {
  constructor(private readonly detectors: readonly Detector[]) {}

  detect(input: DetectorInput): DetectorOutput[] {
    return emitDetections(input, this.detectors);
  }
}
