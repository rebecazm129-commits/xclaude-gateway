// Self-test payload aggregator — composes the canonical list of synthetic
// examples used by the Verify Detection feature.
//
// Sources:
//  - One EXAMPLE_PAYLOAD per active detector (regex chain).
//  - BASELINE_EXAMPLE_PAYLOAD from the engine, representing the tool_call_allowed
//    fallback that emerges when no detector fires.
//
// The list is ordered descending by severity to match the natural order of
// ACTIVE_DETECTORS in the engine, with the baseline at the end.
//
// pii_detected (NER async, off-path) is not included here — when it lands
// in Hito 3 Fase 7, the decision on whether to add it to the synchronous
// self-test or treat it apart will be revisited. pii_structured (regex+checksum)
// IS synchronous and included like the other four.

import type { SelfTestExample } from '@xcg/shared';

import { EXAMPLE_PAYLOAD as credentialExample } from './detectors/credential.js';
import { EXAMPLE_PAYLOAD as promptInjectionExample } from './detectors/prompt-injection.js';
import { EXAMPLE_PAYLOAD as emailSendExample } from './detectors/email-send-warning.js';
import { EXAMPLE_PAYLOAD as dataExportExample } from './detectors/data-export-warning.js';
import { EXAMPLE_PAYLOAD as piiStructuredExample } from './detectors/pii-structured.js';
import { BASELINE_EXAMPLE_PAYLOAD } from './engine.js';

/**
 * Returns the canonical list of self-test examples in display order
 * (severity desc + baseline last).
 */
export function getSelfTestPayloads(): readonly SelfTestExample[] {
  return [
    credentialExample,
    promptInjectionExample,
    emailSendExample,
    dataExportExample,
    piiStructuredExample,
    BASELINE_EXAMPLE_PAYLOAD,
  ];
}
