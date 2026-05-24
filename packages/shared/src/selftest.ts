// Self-test example payload — used by the Verify Detection feature in the desktop app.
//
// Each registered detector contributes one EXAMPLE_PAYLOAD; the engine baseline
// contributes one as well. Together they form the canonical list returned by
// getSelfTestPayloads() in @xcg/proxy.
//
// Synthetic events are routed through the real xcg-proxy wrapper invoking the
// `echo` tool of @modelcontextprotocol/server-everything. The `echo` tool accepts
// strictly `{ message: string }` (additionalProperties: false). Each example
// carries a single `message` string containing the textual trigger; the helper
// toEchoToolCallParams() builds the canonical JSON-RPC `params` shape consumed
// by both the engine tests (regression) and the desktop pipeline (real spawn).
//
// Identification of self-test events at runtime is done structurally by the
// session id of the wrapper spawned by the desktop app, not by inspecting the
// payload contents. This keeps messages minimal and didactic.

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
  /** Textual trigger to be sent as the `message` argument of the echo tool. */
  readonly message: string;
  /** JSON-RPC method to associate with the envelope (always "tools/call" today). */
  readonly method: string;
}

/**
 * Canonical JSON-RPC `params` shape for invoking the echo tool with a
 * self-test example. Single source of truth used by both engine regression
 * tests and the desktop self-test pipeline, guaranteeing identical paramsJson
 * across both surfaces.
 */
export function toEchoToolCallParams(example: SelfTestExample): {
  readonly name: 'echo';
  readonly arguments: { readonly message: string };
} {
  return { name: 'echo', arguments: { message: example.message } };
}

export type SelfTestRunOutcome =
  | { readonly kind: 'complete_pass' }
  | { readonly kind: 'timeout_partial' }
  | { readonly kind: 'detection_mismatch' }
  | { readonly kind: 'timeout_no_data' }
  | { readonly kind: 'spawn_failed'; readonly reason: string };

export interface SelfTestEntryResult {
  readonly example: SelfTestExample;
  readonly actual: { readonly category: Category; readonly severity: Severity } | null;
  readonly pass: boolean;
}

export interface SelfTestReport {
  readonly runId: string;
  readonly startedAt: string;     // ISO timestamp
  readonly finishedAt: string;    // ISO timestamp
  readonly outcome: SelfTestRunOutcome;
  readonly entries: readonly SelfTestEntryResult[];   // siempre presente, parcial admitido
  readonly wrapperSession: string | null;
  readonly auditFile: string | null;
}
