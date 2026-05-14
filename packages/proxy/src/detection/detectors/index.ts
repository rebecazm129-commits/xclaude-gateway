// Detector registry — exports the ordered ACTIVE_DETECTORS chain consumed
// by DetectionEngine. Order: severity descending, alphabetical within level.
// Phase 3 Steps 2-3 ship two CRITICAL detectors (credentialDetected,
// promptInjection).
// The baseline tool_call_allowed remains emitDetections' internal fallback
// and is NOT registered here — that decision is deferred.

import type { Detector } from '../types.js';

import { credentialDetected } from './credential.js';
import { promptInjection } from './prompt-injection.js';

export { credentialDetected, promptInjection };

export const ACTIVE_DETECTORS: readonly Detector[] = [credentialDetected, promptInjection];
