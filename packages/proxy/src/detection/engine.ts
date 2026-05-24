// DetectionEngine — runs an ordered chain of detectors and emits the baseline
// tool_call_allowed when none fire. No real detectors live here; those land
// in Phases 1 (wrapper integration) and 3 (regex detectors).

import type {
  Detector,
  DetectorInput,
  DetectorOutput,
  McpRequestEnvelope,
  SelfTestExample,
} from './types.js';

function baselineToolCallAllowed(): DetectorOutput {
  return {
    category: 'tool_call_allowed',
    severity: 'low',
    findings: [],
  };
}

function extractToolName(envelope: McpRequestEnvelope): string | undefined {
  if (envelope.method !== 'tools/call') return undefined;
  const payload = envelope.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const name = (payload as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : undefined;
}

export function buildDetectorInput(envelope: McpRequestEnvelope): DetectorInput {
  const paramsJson = envelope.payload === undefined ? '' : JSON.stringify(envelope.payload);
  return {
    envelope,
    paramsJson,
    toolName: extractToolName(envelope),
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

  detect(envelope: McpRequestEnvelope): DetectorOutput[] {
    return emitDetections(buildDetectorInput(envelope), this.detectors);
  }
}

export const BASELINE_EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'tool_call_allowed',
  expectedSeverity: 'low',
  label: 'Allowed tool call',
  description: "A benign tool call that produces no detection and is recorded as the baseline.",
  message: 'hello world',
  method: 'tools/call',
};
