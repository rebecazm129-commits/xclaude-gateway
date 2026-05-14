// Detector registry — exports the ordered ACTIVE_DETECTORS chain consumed
// by DetectionEngine. Order: severity descending, alphabetical within level.
// Phase 3 Steps 2-4 ship two CRITICAL detectors (credentialDetected,
// promptInjection) and one HIGH detector (emailSendWarning).
// The baseline tool_call_allowed remains emitDetections' internal fallback
// and is NOT registered here — that decision is deferred.

import type { Detector } from '../types.js';

import { credentialDetected } from './credential.js';
import { emailSendWarning } from './email-send-warning.js';
import { promptInjection } from './prompt-injection.js';

export { credentialDetected, emailSendWarning, promptInjection };

export const ACTIVE_DETECTORS: readonly Detector[] = [credentialDetected, promptInjection, emailSendWarning];
