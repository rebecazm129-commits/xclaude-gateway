// Config types — wrap plan for claude_desktop_config.json (Milestone 4 Phase 1).
// Extended in Milestone 4 Phase 5.1 with IPC result payloads (StatusResult,
// InstallResult, UninstallResult) used by apps/desktop main handlers and
// renderer. CLI stdout JSON uses snake_case with schema:1; IPC uses camelCase
// TS-native types — different contracts on purpose.
// Pure types, no runtime. Consumed by the config parser (Phase 1, read-only)
// and the writer/CLI (Phase 2+). The WrapPlan is DESCRIPTIVE: it states what
// would change, it never mutates or writes anything.

// --- Shape of the on-disk config (tolerant subset) ---

// One entry under "mcpServers". Only the fields the wrapper cares about are
// modeled; unknown fields are preserved verbatim by the writer (Phase 2), so
// they are kept as an opaque rest via `extra`.
export interface McpEntry {
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  // Any other keys present in the original entry, preserved untouched.
  extra?: Readonly<Record<string, unknown>>;
}

// The relevant subset of claude_desktop_config.json. `mcpServers` may be
// absent (valid: means zero MCPs, not an error). Unknown top-level keys are
// preserved verbatim by the writer (Phase 2) via `extra`.
export interface ClaudeConfig {
  mcpServers?: Readonly<Record<string, McpEntry>>;
  extra?: Readonly<Record<string, unknown>>;
}

// --- Wrap plan (descriptive, produced by the read-only parser) ---

// Why an entry is skipped (not wrappable). Reported, never throws.
export type SkipReason =
  | 'no-command'        // remote/url entry or malformed: no `command` field
  | 'already-wrapped';  // command already resolves to xcg-proxy (idempotent)

// One decision per mcpServers entry. Discriminated by `kind`.
export type WrapPlanEntry =
  | {
      kind: 'wrappable';
      name: string;          // the mcpServers key
      original: McpEntry;    // entry as read, untouched
    }
  | {
      kind: 'skipped';
      name: string;
      reason: SkipReason;
    };

// Result of reading + classifying the config. Descriptive only.
// `entries` is empty (not an error) when mcpServers is absent or has 0 keys.
export interface WrapPlan {
  entries: readonly WrapPlanEntry[];
}

// --- Parser result (read-only, never throws) ---

// The parser returns this instead of throwing: corrupt/unreadable config is
// a reported error, not an exception (Phase 1 is read-only and must fail safe).
// `raw` is the parsed JSON value as read from disk. F2 (applyWrap/unwrap)
// operates on it to preserve unknown keys verbatim (entries with custom
// fields, top-level keys outside mcpServers). F1 already has it in memory;
// exposing it avoids a second read and avoids the parser owning a notion
// of "extra" that the transformer would have to recompose.
export type ParseResult =
  | { ok: true; plan: WrapPlan; raw: unknown }
  | { ok: false; error: ParseError };

export type ParseError =
  | { kind: 'not-found' }                    // config file does not exist
  | { kind: 'unreadable'; detail: string }   // permissions / IO error
  | { kind: 'invalid-json'; detail: string } // JSON.parse failed
  | { kind: 'unexpected-shape'; detail: string }; // not an object / mcpServers not an object

// --- IPC result payloads (Milestone 4 Phase 5.1) ---
//
// These are the shapes returned by the IPC handlers in apps/desktop's main
// process to the renderer. They are NOT the same shape as the CLI emits over
// stdout (which is JSON with schema:1 for humans/scripts); these are
// TS-native types for typed contract between main and renderer over Electron
// IPC. The handler always returns one of these; rejection is reserved for
// unexpected errors (handler bug, IPC corruption), not for domain errors
// like "config not found" or "invalid JSON".

export type IpcConfigError =
  | { ok: false; error: { kind: 'not-found' } }
  | { ok: false; error: { kind: 'unreadable'; detail: string } }
  | { ok: false; error: { kind: 'invalid-json'; detail: string } }
  | { ok: false; error: { kind: 'unexpected-shape'; detail: string } }
  | { ok: false; error: { kind: 'invalid-name'; detail: string } }
  | { ok: false; error: { kind: 'invalid-url'; detail: string } }
  | { ok: false; error: { kind: 'name-exists'; detail: string } }
  | { ok: false; error: { kind: 'login-failed'; detail: string } }
  | { ok: false; error: { kind: 'login-invalid-args'; detail: string } };

export interface IpcConfigSummary {
  wrappable: number;
  alreadyWrapped: number;
  skippedOther: number;
}

export type IpcConfigEntry =
  | { kind: 'wrappable'; name: string }
  | { kind: 'skipped'; name: string; reason: SkipReason };

export interface StatusOk {
  ok: true;
  configPresent: boolean;
  configPath: string;
  entries: readonly IpcConfigEntry[];
  summary: IpcConfigSummary;
}

export interface InstallOk {
  ok: true;
  mode: 'dry-run' | 'yes';
  configPath: string;
  xcgPath: string;
  outcome: 'wrote' | 'would_write' | 'noop';
  entries: readonly IpcConfigEntry[];
  summary: IpcConfigSummary;
}

export interface UninstallOk {
  ok: true;
  mode: 'dry-run' | 'yes';
  configPath: string;
  outcome: 'wrote' | 'would_write' | 'noop';
  summary: IpcConfigSummary;
}

export interface AddRemoteOk {
  ok: true;
  op: 'add-remote';
  configPath: string;
  name: string;
  outcome: 'wrote';
}

export interface RemoveRemoteOk {
  ok: true;
  op: 'remove-remote';
  configPath: string;
  name: string;
  outcome: 'wrote' | 'noop';
}

export interface ConnectOk {
  ok: true;
  op: 'connect';
  configPath: string;
  name: string;
  outcome: 'wrote';
}

export type StatusResult = StatusOk | IpcConfigError;
export type InstallResult = InstallOk | IpcConfigError;
export type UninstallResult = UninstallOk | IpcConfigError;
export type AddRemoteResult = AddRemoteOk | IpcConfigError;
export type RemoveRemoteResult = RemoveRemoteOk | IpcConfigError;
export type ConnectResult = ConnectOk | IpcConfigError;
