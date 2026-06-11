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
import { dataExportWarning } from './data-export-warning.js';
import { emailSendWarning } from './email-send-warning.js';
import { piiStructured } from './pii-structured.js';
import { promptInjection } from './prompt-injection.js';

export { credentialDetected, dataExportWarning, emailSendWarning, piiStructured, promptInjection };

export const ACTIVE_DETECTORS: readonly Detector[] = [credentialDetected, promptInjection, emailSendWarning, dataExportWarning, piiStructured];
