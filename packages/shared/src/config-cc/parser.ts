// Tolerant readers for Claude Code project config — F2.1a. Read-only, one
// readFileSync per call, never throws: absence ≡ empty (spike 3 paso 7:
// removing .mcp.json makes `claude mcp list` succeed with zero project
// entries, not error), corrupt JSON is a reported CcFileError. Same fail-safe
// discipline as config/parser.ts, different absence semantics (see types.ts).

import { readFileSync } from 'node:fs';
import type {
  CcFileError,
  CcGatingResult,
  CcMcpJsonResult,
  CcServerEntry,
} from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Read + parse one JSON file, mapping every failure mode to a value.
type ReadJsonOutcome =
  | { kind: 'absent' }
  | { kind: 'parsed'; parsed: unknown }
  | { kind: 'error'; error: CcFileError };

function readJsonFile(path: string): ReadJsonOutcome {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', error: { kind: 'unreadable', detail: code ?? String(e) } };
  }
  try {
    return { kind: 'parsed', parsed: JSON.parse(text) };
  } catch (e) {
    return { kind: 'error', error: { kind: 'invalid-json', detail: (e as Error).message } };
  }
}

// Project one raw entry value into the tolerant CcServerEntry shape. Nothing
// is trusted: a non-object entry yields only `raw` (classified no-command
// downstream); string-typed fields are picked only when actually strings.
function toServerEntry(raw: unknown): CcServerEntry {
  if (!isPlainObject(raw)) return { raw };
  const args = Array.isArray(raw.args) && raw.args.every((x) => typeof x === 'string')
    ? (raw.args as string[])
    : undefined;
  return {
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(isPlainObject(raw.env) ? { env: raw.env as Record<string, string> } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    raw,
  };
}

// Read a project's .mcp.json (path from resolveScopeFiles(...).entriesPath).
// Absent file → ok, present:false, zero servers. Absent mcpServers key →
// ok, present:true, zero servers (same rule as config/parser.ts).
export function readMcpJson(path: string): CcMcpJsonResult {
  const r = readJsonFile(path);
  if (r.kind === 'absent') return { ok: true, present: false, servers: {}, raw: undefined };
  if (r.kind === 'error') return { ok: false, error: r.error };
  if (!isPlainObject(r.parsed)) {
    return { ok: false, error: { kind: 'unexpected-shape', detail: 'root is not an object' } };
  }
  const mcpServers = r.parsed.mcpServers;
  if (mcpServers === undefined) return { ok: true, present: true, servers: {}, raw: r.parsed };
  if (!isPlainObject(mcpServers)) {
    return { ok: false, error: { kind: 'unexpected-shape', detail: 'mcpServers is not an object' } };
  }
  const servers: Record<string, CcServerEntry> = {};
  for (const [name, value] of Object.entries(mcpServers)) {
    servers[name] = toServerEntry(value);
  }
  return { ok: true, present: true, servers, raw: r.parsed };
}

// Pick a gating list tolerantly: absent/malformed key ≡ [], non-string
// members dropped. Fail-safe direction: losing a malformed member makes the
// entry pending (no decision), never enabled.
function stringList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// Read a project's .claude/settings.local.json (path from
// resolveScopeFiles(...).gatingPath). Absent file → ok, present:false, both
// lists empty — the no-decision state (spike 3: the file only exists after
// the user answers the approval dialog).
export function readSettingsLocal(path: string): CcGatingResult {
  const r = readJsonFile(path);
  if (r.kind === 'absent') {
    return { ok: true, present: false, enabled: [], disabled: [], raw: undefined };
  }
  if (r.kind === 'error') return { ok: false, error: r.error };
  if (!isPlainObject(r.parsed)) {
    return { ok: false, error: { kind: 'unexpected-shape', detail: 'root is not an object' } };
  }
  return {
    ok: true,
    present: true,
    enabled: stringList(r.parsed.enabledMcpjsonServers),
    disabled: stringList(r.parsed.disabledMcpjsonServers),
    raw: r.parsed,
  };
}
