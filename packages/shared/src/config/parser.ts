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

/**
 * Whether a name is safe to use as a remote entry's mcpServers key AND as the
 * `--name` passed to `xcg-proxy http/login` (which becomes the Keychain account
 * `${name}:tokens` etc., written via /usr/bin/security without shell-escaping).
 * Unlike stdio names (which come from the user's existing config and are trusted
 * by construction), remote names are chosen by xCLAUDE, so they must be validated
 * before they reach the Keychain CLI or the args array.
 * Conservative allowlist: ASCII letters, digits, dot, underscore, hyphen; 1–64 chars.
 */
export function isSafeRemoteName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

// --- Idempotency: is this entry already wrapped by xcg-proxy? ---

// An entry is "already wrapped" iff command's basename is xcg-proxy AND args
// start with the wrapper contract in either of the two recognized forms:
//   Current (post Hito 6 sub-step 2.b):  stdio --wrap <x> --name <y> -- ...
//   Legacy  (pre Hito 6 sub-step 2.b):   --wrap <x> --name <y> -- ...
// Both are recognized so that uninstall can clean up entries on disk written
// by older versions of xcg-config, and so install does not double-wrap them.
// Basename alone is not enough (false positives from an unrelated binary
// named xcg-proxy; and post gamma-fix the command is the stable symlink,
// also named xcg-proxy). Checking the arg shape removes both false cases.
export function isAlreadyWrapped(command: string, args: readonly string[]): boolean {
  if (basename(command) !== 'xcg-proxy') return false;
  if (args[0] === 'http') {
    return (
      args.length >= 5 &&
      args[1] === '--url' &&
      args[3] === '--name'
    );
  }
  if (args[0] === 'stdio') {
    return (
      args.length >= 6 &&
      args[1] === '--wrap' &&
      args[3] === '--name' &&
      args[5] === '--'
    );
  }
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
    return { kind: 'skipped', name, reason: 'no-command', transport: null, endpoint: null };
  }
  const command = raw.command;
  const args = isStringArray(raw.args) ? raw.args : [];
  if (isAlreadyWrapped(command, args)) {
    // Derive transport/endpoint from the arg shape isAlreadyWrapped just
    // verified (positions are trusted because the entry is ours):
    //   http:   ['http','--url',<url>,'--name',<name>]           → url
    //   stdio:  ['stdio','--wrap',<cmd>,'--name',<name>,'--',…]  → wrapped cmd
    //   legacy: ['--wrap',<cmd>,'--name',<name>,'--',…]          → wrapped cmd
    if (args[0] === 'http') {
      return { kind: 'skipped', name, reason: 'already-wrapped', transport: 'http', endpoint: args[2] };
    }
    const endpoint = args[0] === 'stdio' ? args[2] : args[1];
    return { kind: 'skipped', name, reason: 'already-wrapped', transport: 'stdio', endpoint };
  }
  // Preserve the entry as read; the writer (Phase 2) consumes `original`.
  const original: McpEntry = {
    command,
    ...(isStringArray(raw.args) ? { args: raw.args } : {}),
    ...(isPlainObject(raw.env) ? { env: raw.env as Record<string, string> } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
  };
  return { kind: 'wrappable', name, original, transport: 'stdio', endpoint: command };
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
    return { ok: true, plan: { entries: [] }, raw: parsed };
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
  return { ok: true, plan, raw: parsed };
}
