// Config transform — pure functions to wrap/unwrap claude_desktop_config.json
// (Milestone 4 Phase 2). Operates on the raw parsed JSON (not the projected
// ClaudeConfig type) so unknown keys are preserved verbatim. No IO, no
// mutation: every function returns a new value; the input is untouched.

import { isAlreadyWrapped } from './parser.js';
import type { WrapPlan } from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// Names of entries to wrap, extracted from the plan. Skipped entries
// (no-command, already-wrapped) are left untouched.
function wrappableNames(plan: WrapPlan): Set<string> {
  const s = new Set<string>();
  for (const e of plan.entries) if (e.kind === 'wrappable') s.add(e.name);
  return s;
}

// Build a wrapped entry from the original entry's raw object. Copies every
// key verbatim, then overrides `command` and `args` with the wrapper contract.
// env/cwd/extras flow through untouched.
function wrapEntry(name: string, original: Record<string, unknown>, xcgPath: string): Record<string, unknown> {
  const origCommand = typeof original.command === 'string' ? original.command : '';
  const origArgs = isStringArray(original.args) ? original.args : [];
  return {
    ...original,
    command: xcgPath,
    args: ['--wrap', origCommand, '--name', name, '--', ...origArgs],
  };
}

// Inverse of wrapEntry. Reads the wrapper contract from args, restores the
// original command and args, preserves env/cwd/extras. Caller must verify
// isAlreadyWrapped(command, args) before invoking.
function unwrapEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const args = isStringArray(entry.args) ? entry.args : [];
  const origCommand = args[1] ?? '';
  const origArgs = args.slice(5);
  // Strip the wrapper-injected command/args; spread the rest to preserve extras.
  const { command: _c, args: _a, ...rest } = entry;
  return { ...rest, command: origCommand, args: origArgs };
}

// --- Public surface ---

// Apply the wrap plan to the raw config. Iterates mcpServers, transforms
// only entries listed as wrappable in the plan, leaves everything else
// (other top-level keys, skipped entries) byte-for-byte. Pure: returns a
// new object; `raw` is not mutated.
export function applyWrap(raw: unknown, plan: WrapPlan, xcgPath: string): unknown {
  if (!isPlainObject(raw)) return raw;
  const mcp = raw.mcpServers;
  if (!isPlainObject(mcp)) return { ...raw };
  const targets = wrappableNames(plan);
  const newMcp: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (targets.has(name) && isPlainObject(entry)) {
      newMcp[name] = wrapEntry(name, entry, xcgPath);
    } else {
      newMcp[name] = entry;
    }
  }
  return { ...raw, mcpServers: newMcp };
}

// Inverse of applyWrap. Iterates mcpServers and restores any entry detected
// as wrapped (by isAlreadyWrapped, the same predicate F1 uses). Non-wrapped
// entries pass through. Pure: returns a new object.
export function unwrap(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const mcp = raw.mcpServers;
  if (!isPlainObject(mcp)) return { ...raw };
  const newMcp: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (isPlainObject(entry)) {
      const cmd = typeof entry.command === 'string' ? entry.command : '';
      const args = isStringArray(entry.args) ? entry.args : [];
      newMcp[name] = isAlreadyWrapped(cmd, args) ? unwrapEntry(entry) : entry;
    } else {
      newMcp[name] = entry;
    }
  }
  return { ...raw, mcpServers: newMcp };
}
