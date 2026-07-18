// Types for the Claude Code (CLI) config surface — F2.1a. Pure types, no
// runtime. Scope types live in ./scopes.ts (co-located with the resolution,
// per the F2.1a dictate); these cover the tolerant readers (./parser.ts) and
// the entry classification (./classify.ts). Shapes fixed by spike 3
// (2026-07-18, fixtures in tests/fixtures/config-cc/).

// --- Shape of one mcpServers entry (tolerant subset) ---

// As Claude Code writes them (spike 3): stdio → explicit `"type": "stdio"`,
// `command` + `args` with absolute paths, `env: {}` present even when empty;
// http → minimal `type` + `url`. `type` is kept as a plain string, not
// narrowed: unknown transports must classify (as unsupported), not crash.
export interface CcServerEntry {
  type?: string;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  // The entry exactly as parsed, unknown keys included (may be a non-object
  // for malformed entries — never trusted). F2.1b's wrap path operates on
  // raw values to preserve foreign fields verbatim, like config/transform.
  raw: unknown;
}

// --- Reader results (tolerant, never throw) ---

// Unlike config/types' ParseError there is NO 'not-found' member: for both
// .mcp.json and settings.local.json absence ≡ empty (spike 3 pasos 7 and 6),
// so a missing file is an ok result with present:false, not an error.
export type CcFileError =
  | { kind: 'unreadable'; detail: string }   // permissions / IO error
  | { kind: 'invalid-json'; detail: string } // JSON.parse failed
  | { kind: 'unexpected-shape'; detail: string }; // root/mcpServers not an object

// Result of reading a .mcp.json. `present` distinguishes absent-file from
// empty-file — same servers, but F2.1b must know whether to create or edit.
// `raw` is the parsed JSON as read (undefined when absent), exposed for the
// same reason config/types' ParseResult exposes it: the F2.1b writer needs
// it to preserve unknown keys verbatim without a second read.
export type CcMcpJsonResult =
  | { ok: true; present: boolean; servers: Readonly<Record<string, CcServerEntry>>; raw: unknown }
  | { ok: false; error: CcFileError };

// Result of reading a .claude/settings.local.json gating file. Spike 3:
// approving all writes ONLY enabledMcpjsonServers, rejecting all writes ONLY
// disabledMcpjsonServers — the absent key (and the absent file) ≡ [].
export type CcGatingResult =
  | { ok: true; present: boolean; enabled: readonly string[]; disabled: readonly string[]; raw: unknown }
  | { ok: false; error: CcFileError };

// --- Classification (entry × gating) ---

// Why an entry is unsupported (not actionable by the gateway). http/sse are
// fixed by the approved F2.1 design; no-command covers malformed or
// url-without-type entries the stdio wrap could never target.
export type CcUnsupportedReason = 'type-http' | 'type-sse' | 'no-command';

export type CcEntryStatus = 'enabled' | 'disabled' | 'pending' | 'unsupported';

// One decision per entry, discriminated by `status`. Descriptive only — the
// F2.1b plan consumes it; nothing here mutates or writes.
export type CcClassifiedEntry =
  | { status: 'enabled' | 'disabled' | 'pending'; name: string; entry: CcServerEntry }
  | { status: 'unsupported'; name: string; reason: CcUnsupportedReason; entry: CcServerEntry };
