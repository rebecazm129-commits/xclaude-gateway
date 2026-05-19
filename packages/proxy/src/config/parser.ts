// Config parser — read-only classifier for claude_desktop_config.json
// (Milestone 4 Phase 1). Pure w.r.t. the filesystem except a single
// readFileSync; never throws. Corrupt/unreadable config is a reported
// ParseError, not an exception (Phase 1 must fail safe and never mutate).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  ClaudeConfig,
  McpEntry,
  ParseResult,
  WrapPlan,
  WrapPlanEntry,
} from './types.js';

// --- Runtime type guards (narrow unknown without trusting the on-disk shape) ---

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// --- Idempotency: is this entry already wrapped by xcg-proxy? ---

// An entry is "already wrapped" iff command's basename is xcg-proxy AND args
// start with the exact wrapper contract: --wrap <x> --name <y> -- ...
// Basename alone is not enough (false positives from an unrelated binary
// named xcg-proxy; and post gamma-fix the command is the stable symlink,
// also named xcg-proxy). Checking the arg shape removes both false cases.
function isAlreadyWrapped(command: string, args: readonly string[]): boolean {
  if (basename(command) !== 'xcg-proxy') return false;
  return (
    args.length >= 5 &&
    args[0] === '--wrap' &&
    args[2] === '--name' &&
    args[4] === '--'
  );
}

// --- Classify one mcpServers entry (descriptive, no mutation) ---

function classifyEntry(name: string, raw: unknown): WrapPlanEntry {
  if (!isPlainObject(raw) || typeof raw.command !== 'string') {
    // Remote/url entries and malformed entries have no usable `command`.
    return { kind: 'skipped', name, reason: 'no-command' };
  }
  const command = raw.command;
  const args = isStringArray(raw.args) ? raw.args : [];
  if (isAlreadyWrapped(command, args)) {
    return { kind: 'skipped', name, reason: 'already-wrapped' };
  }
  // Preserve the entry as read; the writer (Phase 2) consumes `original`.
  const original: McpEntry = {
    command,
    ...(isStringArray(raw.args) ? { args: raw.args } : {}),
    ...(isPlainObject(raw.env) ? { env: raw.env as Record<string, string> } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
  };
  return { kind: 'wrappable', name, original };
}

// --- Public entrypoint: read + classify, never throws ---

export function parseConfig(configPath: string): ParseResult {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: false, error: { kind: 'not-found' } };
    return {
      ok: false,
      error: { kind: 'unreadable', detail: code ?? String(e) },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'invalid-json', detail: (e as Error).message },
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: { kind: 'unexpected-shape', detail: 'root is not an object' },
    };
  }

  const mcpServers = (parsed as ClaudeConfig).mcpServers;
  if (mcpServers === undefined) {
    // Absent mcpServers is valid: zero MCPs, empty plan, not an error.
    return { ok: true, plan: { entries: [] } };
  }
  if (!isPlainObject(mcpServers)) {
    return {
      ok: false,
      error: { kind: 'unexpected-shape', detail: 'mcpServers is not an object' },
    };
  }

  const entries: WrapPlanEntry[] = Object.keys(mcpServers).map((name) =>
    classifyEntry(name, (mcpServers as Record<string, unknown>)[name]),
  );
  const plan: WrapPlan = { entries };
  return { ok: true, plan };
}
