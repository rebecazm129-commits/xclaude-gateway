// Detector registry — exports the ordered ACTIVE_DETECTORS chain consumed
// by DetectionEngine. Order: severity descending, alphabetical within level.
// Phase 3 Step 2 ships a single CRITICAL detector (credentialDetected).
// The baseline tool_call_allowed remains emitDetections' internal fallback
// and is NOT registered here — that decision is deferred.

import type { Detector } from '../types.js';

import { credentialDetected } from './credential.js';

export { credentialDetected };

export const ACTIVE_DETECTORS: readonly Detector[] = [credentialDetected];
