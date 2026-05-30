// Config transform — pure functions to wrap/unwrap claude_desktop_config.json
// (Milestone 4 Phase 2). Operates on the raw parsed JSON (not the projected
// ClaudeConfig type) so unknown keys are preserved verbatim. No IO, no
// mutation: every function returns a new value; the input is untouched.

import { isAlreadyWrapped, isSafeRemoteName } from './parser.js';
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
    args: ['stdio', '--wrap', origCommand, '--name', name, '--', ...origArgs],
  };
}

// Inverse of wrapEntry. Reads the wrapper contract from args, restores the
// original command and args, preserves env/cwd/extras. Caller must verify
// isAlreadyWrapped(command, args) before invoking. Handles both the legacy
// pre-2.b form (--wrap as args[0]) and the current form (stdio as args[0]).
function unwrapEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const args = isStringArray(entry.args) ? entry.args : [];
  const offset = args[0] === 'stdio' ? 1 : 0;
  const origCommand = args[offset + 1] ?? '';
  const origArgs = args.slice(offset + 5);
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

// --- Remote entries (Hito 6 Phase 5): create from scratch, not wrap-existing ---
// Remote MCP servers cannot live in claude_desktop_config.json as `url` entries
// (Claude Desktop silently deletes them — issue #37286). The only viable form is
// a stdio-bridge entry whose command is xcg-proxy in `http` mode, with the URL
// carried INSIDE args (opaque to Desktop). xCLAUDE creates this entry from
// scratch (the user never has it), so name and url must be validated here.

export type AddRemoteToConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: 'invalid-name' | 'invalid-url' | 'name-exists' | 'bad-config' };

// Builds the bridge entry object. Exported for unit testing the exact shape.
export function createRemoteEntry(name: string, url: string, xcgPath: string): Record<string, unknown> {
  return { command: xcgPath, args: ['http', '--url', url, '--name', name] };
}

// Inserts a new remote bridge entry under mcpServers[name], preserving everything
// else (other entries, unknown top-level keys) via spread. Does NOT overwrite an
// existing key (returns 'name-exists'). Returns the full config object for writeAtomic.
export function addRemoteToConfig(raw: unknown, name: string, url: string, xcgPath: string): AddRemoteToConfigResult {
  if (!isSafeRemoteName(name)) return { ok: false, error: 'invalid-name' };
  try { new URL(url); } catch { return { ok: false, error: 'invalid-url' }; }
  if (!isPlainObject(raw)) return { ok: false, error: 'bad-config' };
  const mcp = isPlainObject(raw.mcpServers) ? raw.mcpServers : {};
  if (name in mcp) return { ok: false, error: 'name-exists' };
  const newMcp = { ...mcp, [name]: createRemoteEntry(name, url, xcgPath) };
  return { ok: true, config: { ...raw, mcpServers: newMcp } };
}

// Removes a remote bridge entry under mcpServers[name]. Symmetric to
// addRemoteToConfig. Unlike unwrap (which restores a wrapped stdio entry's
// original), a remote entry has no pre-existing original to restore — the user
// never had it — so removal just deletes the key. To avoid clobbering an
// unrelated entry that happens to share the name, deletion only happens if the
// entry IS one of ours: command basename xcg-proxy + http bridge args
// (isAlreadyWrapped recognizes that shape since pieza 3). Returns the full
// config object for writeAtomic.
export type RemoveRemoteFromConfigResult =
  | { ok: true; config: Record<string, unknown>; removed: boolean }
  | { ok: false; error: 'bad-config' };

export function removeRemoteFromConfig(raw: unknown, name: string): RemoveRemoteFromConfigResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'bad-config' };
  const mcp = isPlainObject(raw.mcpServers) ? raw.mcpServers : {};
  const entry = mcp[name];
  if (!isPlainObject(entry)) return { ok: true, config: { ...raw }, removed: false };
  const cmd = typeof entry.command === 'string' ? entry.command : '';
  const args = isStringArray(entry.args) ? entry.args : [];
  // isAlreadyWrapped matches BOTH the http and stdio/legacy shapes. That is
  // intentional here: if the name points to any xcg-proxy-wrapped entry of
  // ours, it is ours and removing it is valid (the remote use case is http,
  // but a stdio-wrapped match is still legitimately ours to delete).
  if (!isAlreadyWrapped(cmd, args)) {
    // Not one of ours (or not a recognized bridge) — leave it untouched.
    return { ok: true, config: { ...raw }, removed: false };
  }
  const newMcp: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mcp)) {
    if (k !== name) newMcp[k] = v;
  }
  return { ok: true, config: { ...raw, mcpServers: newMcp }, removed: true };
}
