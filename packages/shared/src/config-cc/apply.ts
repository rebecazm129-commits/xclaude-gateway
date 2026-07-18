// Plan application for Claude Code config — F2.1b. PURE: takes the parsed
// .mcp.json value (the `raw` readMcpJson exposes) plus a CcPlan and returns
// the file's new content as a value. Writing it to disk (freshness check +
// tmp/rename + post-write verification) is F2.1c. Composes transform's raw
// wrapEntry/unwrapEntry (decision B) — single source of the wrapper contract.
//
// Everything foreign is preserved byte-identical: unknown top-level keys and
// untouched servers keep their reference and their position; unknown entry
// fields flow through the raw functions' spreads.
//
// Key-order restoration on unwrap: transform's unwrapEntry re-appends
// command/args at the END of the entry (Desktop never cared about entry key
// order), but wrapEntry spreads the original FIRST, so a wrapped entry on
// disk still carries the original key order. Rebuilding the unwrapped entry
// in the wrapped entry's key order therefore restores the original, keeping
// the wrap→unwrap round-trip byte-identical (F2.1b dictate).

import { isAlreadyWrapped } from '../config/parser.js';
import { unwrapEntry, wrapEntry } from '../config/transform.js';
import type { CcPlan } from './plan.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// Rebuild `values` following `order`'s key order. Both hold the same key set
// (unwrapEntry only relocates command/args); see header for why this makes
// the round-trip byte-identical.
function inKeyOrderOf(
  order: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(order)) out[k] = values[k];
  return out;
}

// Apply the plan to the parsed .mcp.json value. Pure: returns a new object;
// `raw` is not mutated. Entries without an action (or with 'skip') pass
// through by reference; plan actions naming entries absent from raw are
// ignored (the plan was computed against a different snapshot — F2.1c's
// freshness check owns detecting that).
export function applyPlan(raw: unknown, plan: CcPlan, xcgPath: string): unknown {
  // Shape guards (F2.1b condition 3): a non-object root or mcpServers means
  // there is nothing to transform — return the input untouched.
  if (!isPlainObject(raw)) return raw;
  const mcp = raw.mcpServers;
  if (!isPlainObject(mcp)) return raw;

  const byName = new Map(plan.actions.map((a) => [a.name, a]));
  const newMcp: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    const action = byName.get(name);
    if (action === undefined || action.action === 'skip' || !isPlainObject(entry)) {
      newMcp[name] = entry;
      continue;
    }
    // Re-check the plan's own gate against the entry actually in raw. This
    // makes applyPlan idempotent (applying the same plan twice ≡ once: the
    // second pass finds the entry already in the desired state and leaves
    // it alone) and is the last line of defense keeping a non-wrapped entry
    // away from unwrapEntry's silent corruption — and a wrapped one away
    // from a double wrap — if a plan was computed against a stale raw.
    const cmd = typeof entry.command === 'string' ? entry.command : '';
    const args = isStringArray(entry.args) ? entry.args : [];
    const wrapped = isAlreadyWrapped(cmd, args);
    if (action.action === 'wrap') {
      newMcp[name] = wrapped ? entry : wrapEntry(name, entry, xcgPath);
    } else {
      newMcp[name] = wrapped ? inKeyOrderOf(entry, unwrapEntry(entry)) : entry;
    }
  }
  return { ...raw, mcpServers: newMcp };
}
