// Detection types — contract surface for the detection engine.
// Pure types, no runtime. Consumed by engine.ts and the wrapper (Phase 1+).

import type { Direction } from '../events.js';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Category =
  | 'credential_detected'
  | 'prompt_injection'
  | 'email_send_warning'
  | 'data_export_warning'
  | 'tool_call_allowed'
  | 'pii_detected';

export interface DetectionFinding {
  type: string;
  location?: string;
}

export interface DetectorOutput {
  category: Category;
  severity: Severity;
  findings: DetectionFinding[];
}

export interface DetectorInput {
  payload: unknown;
  mcp: string;
  method: string | null;
  direction: Direction;
  sessionId: string;
}

export type Detector = (input: DetectorInput) => DetectorOutput | null;

export type DetectionBlock = DetectorOutput;
