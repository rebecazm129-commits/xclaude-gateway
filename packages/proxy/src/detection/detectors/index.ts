// Detector registry — exports the ordered ACTIVE_DETECTORS chain consumed
// by DetectionEngine. Order: severity descending, alphabetical within level.
// Phase 3 Steps 2-5 ship the full vertical slice: two CRITICAL detectors
// (credentialDetected, promptInjection), one HIGH detector (emailSendWarning),
// and two MEDIUM detectors (dataExportWarning, then piiStructured — alphabetical
// within the medium level: data_export_warning < pii_structured).
// The baseline tool_call_allowed remains emitDetections' internal fallback
// and is NOT registered here — that decision is deferred.

import type { Detector } from '../types.js';

import { credentialDetected } from './credential.js';
import { dataExportWarning, dataExportWarningInbound } from './data-export-warning.js';
import { emailSendWarning } from './email-send-warning.js';
import { piiStructured } from './pii-structured.js';
import { promptInjection } from './prompt-injection.js';

export { credentialDetected, dataExportWarning, dataExportWarningInbound, emailSendWarning, piiStructured, promptInjection };
export { credentialMatches } from './credential.js';

export const ACTIVE_DETECTORS: readonly Detector[] = [credentialDetected, promptInjection, emailSendWarning, dataExportWarning, piiStructured];

// CONTENT_DETECTORS — the INBOUND chain, run over tools/call RESULT text.
// Shared by BOTH ingest routes (the wrapper's frame-processor and the Claude
// Code hook's cchook-ingest) so their result classification can never drift
// apart again — the 27/08 audit found cchook still on the 07/07 broad+low
// behavior while the proxy had moved on. It differs from ACTIVE_DETECTORS in
// exactly one entry: data_export_warning runs its STRICT inbound variant
// (explicit destination required — see data-export-warning.ts), so what fires
// keeps the detector's own 'medium'; the strictness lives in the regex, not
// in a severity downgrade. NER (pii_detected) is deliberately absent:
// off-path/async, request-path only. emailSendWarning's tool-name branch is
// inert inbound — callers pass toolName: undefined (a result has no tool
// name to classify), which is correct.
export const CONTENT_DETECTORS: readonly Detector[] = [
  credentialDetected,
  promptInjection,
  emailSendWarning,
  dataExportWarningInbound,
  piiStructured,
];
