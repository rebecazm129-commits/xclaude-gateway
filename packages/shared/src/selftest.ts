// Self-test example payload — used by the Verify Detection feature in the desktop app.
// Each registered detector contributes one EXAMPLE_PAYLOAD; the engine baseline contributes one
// as well. Together they form the canonical list returned by getSelfTestPayloads() in @xcg/proxy.
//
// Identification of self-test events at runtime is done structurally by the session id of the
// wrapper spawned by the desktop app, not by inspecting the payload contents. This keeps
// payloads minimal and didactic.

import type { Category, Severity } from './index.js';

export interface SelfTestExample {
  /** Category that this example is designed to produce when run through DetectionEngine. */
  readonly categoryKey: Category;
  /** Severity that the produced detection should have. */
  readonly expectedSeverity: Severity;
  /** Short human-readable label for the UI ("Credential leak", "Prompt injection", etc.). */
  readonly label: string;
  /** One-sentence description explaining what this example demonstrates. */
  readonly description: string;
  /** Payload to send; the consumer wraps it in an McpRequestEnvelope before invoking the engine. */
  readonly payload: unknown;
  /** JSON-RPC method to associate with the envelope (e.g. "tools/call"). */
  readonly method: string;
}
