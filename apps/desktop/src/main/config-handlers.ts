// Config handlers for the desktop main process (Milestone 4 Phase 5.1 sub-step C2).
// Pure functions composed from @xcg/shared/config (parseConfig, applyWrap,
// unwrap, writeAtomic). Returned shapes match the IPC result types in
// @xcg/shared/config/types.ts (StatusResult / InstallResult / UninstallResult).
//
// The ipcMain.handle wrappers in main/index.ts invoke these directly. Tests
// in tests/main/config-handlers.test.ts exercise these without spawning
// Electron (no app.isPackaged dependency in the pure functions; xcgPath is
// passed in by main/index.ts via resolveXcgPathFromMain).

import { app } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addRemoteToConfig,
  applyWrap,
  isAlreadyWrapped,
  parseConfig,
  removeRemoteFromConfig,
  STABLE_XCG_PROXY_PATH,
  unwrap,
  writeAtomic,
  type AddRemoteResult,
  type InstallResult,
  type IpcConfigEntry,
  type IpcConfigError,
  type IpcConfigSummary,
  type IsConnectedResult,
  type ParseError,
  type RemoveRemoteResult,
  type StatusResult,
  type UninstallResult,
  type WrapPlanEntry,
  type WriteAtomicError,
} from '@xcg/shared/config';

// --- xcgPath resolution from the main process (D-C2-3) ---
//
// Different from cli.ts's resolveXcgPath: the CLI inspects process.argv[1]
// (bundle path); the main process uses app.isPackaged. Same target in
// packaged mode (the stable symlink F3b creates), different fallback in dev
// (the absolute path to the repo's bin/xcg-proxy).
export function resolveXcgPathFromMain(): string {
  if (app.isPackaged) {
    return STABLE_XCG_PROXY_PATH;
  }
  // Dev: resolve to <repo>/packages/proxy/bin/xcg-proxy relative to this
  // module's location at <repo>/apps/desktop/src/main/config-handlers.ts.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', '..', '..', 'packages', 'proxy', 'bin', 'xcg-proxy');
}

/**
 * Resolves the REAL target binary path for ensureSymlink in runRepairWraps.
 *
 * Distinct from resolveXcgPathFromMain (which returns the stable canonical
 * path written into config wraps). In packaged builds, the two values diverge:
 *   - resolveXcgPathFromMain → STABLE_XCG_PROXY_PATH (the symlink itself)
 *   - resolveXcgTargetPathFromMain → join(process.resourcesPath, 'proxy',
 *     'bin', 'xcg-proxy') (the actual binary inside the .app, target of the
 *     symlink)
 *
 * In dev, both return the same path (the script in the repo) because there is
 * no symlink layer.
 *
 * Introduced in C4.E-FIX.A to eliminate the cycle bug found in C4.E.4 smoke:
 * runRepairWraps was previously using resolveXcgPathFromMain for BOTH the
 * ensureSymlink target AND the canonical wrap command, causing
 * ensureSymlink(STABLE, STABLE) → self-referential symlink in packaged.
 */
export function resolveXcgTargetPathFromMain(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'proxy', 'bin', 'xcg-proxy');
  }
  // Dev: same as resolveXcgPathFromMain — the script in the repo.
  return resolveXcgPathFromMain();
}

// --- Internal helpers (camelCase for IPC, parallel to cli.ts snake_case) ---

function entryToIpc(entry: WrapPlanEntry): IpcConfigEntry {
  if (entry.kind === 'wrappable') {
    return { kind: 'wrappable', name: entry.name, transport: entry.transport ?? null, endpoint: entry.endpoint ?? null };
  }
  return { kind: 'skipped', name: entry.name, reason: entry.reason, transport: entry.transport ?? null, endpoint: entry.endpoint ?? null };
}

function summarize(entries: readonly WrapPlanEntry[]): IpcConfigSummary {
  let wrappable = 0;
  let alreadyWrapped = 0;
  let skippedOther = 0;
  for (const e of entries) {
    if (e.kind === 'wrappable') wrappable++;
    else if (e.reason === 'already-wrapped') alreadyWrapped++;
    else skippedOther++;
  }
  return { wrappable, alreadyWrapped, skippedOther };
}

function parseErrorToIpc(err: ParseError): IpcConfigError {
  if (err.kind === 'not-found') {
    return { ok: false, error: { kind: 'not-found' } };
  }
  // unreadable | invalid-json | unexpected-shape — all carry detail.
  return { ok: false, error: { kind: err.kind, detail: err.detail } };
}

function writeAtomicErrorToIpc(err: WriteAtomicError): IpcConfigError {
  // Both permission and io collapse to 'unreadable' in the IPC error space
  // (same logic as cli.ts: from the consumer's perspective the disk is in
  // the way). Detail preserves the specific cause.
  return {
    ok: false,
    error: { kind: 'unreadable', detail: `${err.kind}: ${err.detail}` },
  };
}

// Maps the validation errors from addRemoteToConfig/removeRemoteFromConfig to the
// IPC error space. The first three map 1:1 to the kinds added in estrato 2a (the
// renderer can show specific onboarding messages); 'bad-config' is effectively
// unreachable after a successful parseConfig (which already rejects non-object
// configs as unexpected-shape), but is mapped defensively to unexpected-shape.
function createRemoteErrorToIpc(
  e: 'invalid-name' | 'invalid-url' | 'name-exists' | 'bad-config',
): IpcConfigError {
  switch (e) {
    case 'invalid-name':
      return { ok: false, error: { kind: 'invalid-name', detail: 'Name must be 1-64 chars: letters, digits, dot, underscore, hyphen.' } };
    case 'invalid-url':
      return { ok: false, error: { kind: 'invalid-url', detail: 'The server URL is not a valid URL.' } };
    case 'name-exists':
      return { ok: false, error: { kind: 'name-exists', detail: 'A connector with that name already exists.' } };
    case 'bad-config':
      return { ok: false, error: { kind: 'unexpected-shape', detail: 'config has an unexpected shape.' } };
  }
}

// --- Pure handlers (D-C2-5) ---

export interface ConfigHandlerOptions {
  configPath: string;
  xcgPath: string;
}

export function runConfigStatus(opts: ConfigHandlerOptions): StatusResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') {
      // not-found is a valid initial state in status, not an error.
      // The renderer interprets configPresent:false as "Claude Desktop
      // has no MCP config yet" rather than "something is broken".
      return {
        ok: true,
        configPresent: false,
        configPath: opts.configPath,
        entries: [],
        summary: { wrappable: 0, alreadyWrapped: 0, skippedOther: 0 },
      };
    }
    return parseErrorToIpc(parsed.error);
  }
  return {
    ok: true,
    configPresent: true,
    configPath: opts.configPath,
    entries: parsed.plan.entries.map(entryToIpc),
    summary: summarize(parsed.plan.entries),
  };
}

export function runConfigInstall(
  opts: ConfigHandlerOptions,
  mode: 'dry-run' | 'yes',
): InstallResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') {
      return {
        ok: false,
        error: {
          kind: 'unreadable',
          detail:
            'claude_desktop_config.json not found. Open Claude Desktop and add at least one MCP server first.',
        },
      };
    }
    return parseErrorToIpc(parsed.error);
  }

  const wrapped = applyWrap(parsed.raw, parsed.plan, opts.xcgPath);
  const summary = summarize(parsed.plan.entries);
  const isNoop = summary.wrappable === 0;

  if (mode === 'dry-run') {
    return {
      ok: true,
      mode: 'dry-run',
      configPath: opts.configPath,
      xcgPath: opts.xcgPath,
      outcome: isNoop ? 'noop' : 'would_write',
      entries: parsed.plan.entries.map(entryToIpc),
      summary,
    };
  }

  // mode === 'yes': commit
  let outcome: 'wrote' | 'noop' = 'noop';
  if (!isNoop) {
    const wr = writeAtomic(opts.configPath, wrapped);
    if (!wr.ok) {
      return writeAtomicErrorToIpc(wr.error);
    }
    outcome = 'wrote';
  }
  return {
    ok: true,
    mode: 'yes',
    configPath: opts.configPath,
    xcgPath: opts.xcgPath,
    outcome,
    entries: parsed.plan.entries.map(entryToIpc),
    summary,
  };
}

export function runConfigUninstall(
  opts: ConfigHandlerOptions,
  mode: 'dry-run' | 'yes',
): UninstallResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') {
      return {
        ok: false,
        error: {
          kind: 'unreadable',
          detail: 'claude_desktop_config.json not found. Nothing to uninstall.',
        },
      };
    }
    return parseErrorToIpc(parsed.error);
  }

  const summary = summarize(parsed.plan.entries);
  const isNoop = summary.alreadyWrapped === 0;
  const unwrapped = unwrap(parsed.raw);

  if (mode === 'dry-run') {
    return {
      ok: true,
      mode: 'dry-run',
      configPath: opts.configPath,
      outcome: isNoop ? 'noop' : 'would_write',
      summary,
    };
  }

  let outcome: 'wrote' | 'noop' = 'noop';
  if (!isNoop) {
    const wr = writeAtomic(opts.configPath, unwrapped);
    if (!wr.ok) {
      return writeAtomicErrorToIpc(wr.error);
    }
    outcome = 'wrote';
  }
  return {
    ok: true,
    mode: 'yes',
    configPath: opts.configPath,
    outcome,
    summary,
  };
}

export function runConfigAddRemote(
  opts: ConfigHandlerOptions,
  params: { name: string; url: string },
): AddRemoteResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) return parseErrorToIpc(parsed.error);
  const res = addRemoteToConfig(parsed.raw, params.name, params.url, opts.xcgPath);
  if (!res.ok) return createRemoteErrorToIpc(res.error);
  const wr = writeAtomic(opts.configPath, res.config);
  if (!wr.ok) return writeAtomicErrorToIpc(wr.error);
  return { ok: true, op: 'add-remote', configPath: opts.configPath, name: params.name, outcome: 'wrote' };
}

export function runConfigRemoveRemote(
  opts: ConfigHandlerOptions,
  params: { name: string },
): RemoveRemoteResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) return parseErrorToIpc(parsed.error);
  const res = removeRemoteFromConfig(parsed.raw, params.name);
  if (!res.ok) return createRemoteErrorToIpc(res.error);
  if (!res.removed) return { ok: true, op: 'remove-remote', configPath: opts.configPath, name: params.name, outcome: 'noop' };
  const wr = writeAtomic(opts.configPath, res.config);
  if (!wr.ok) return writeAtomicErrorToIpc(wr.error);
  return { ok: true, op: 'remove-remote', configPath: opts.configPath, name: params.name, outcome: 'wrote' };
}

// Narrows a raw mcpServers entry to the shape isAlreadyWrapped needs. Private
// copy of the same guard in health-handlers.ts (one tiny guard is not worth a
// cross-module export).
function isWrapShape(value: unknown): value is { command: string; args: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { command?: unknown; args?: unknown };
  if (typeof v.command !== 'string') return false;
  if (!Array.isArray(v.args)) return false;
  if (!v.args.every((a) => typeof a === 'string')) return false;
  return true;
}

// Status query (not an operation): is there a remote (http) connector of ours
// under mcpServers[name]? A missing config means unambiguously "not connected"
// (connected:false, NOT an error) — unlike runConfigAddRemote, where not-found
// is an error. Only a corrupt/unreadable config is reported as IpcConfigError.
export function runConfigIsConnected(
  opts: ConfigHandlerOptions,
  params: { name: string },
): IsConnectedResult {
  const parsed = parseConfig(opts.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') return { ok: true, connected: false };
    return parseErrorToIpc(parsed.error);
  }
  const raw = parsed.raw;
  if (typeof raw !== 'object' || raw === null) return { ok: true, connected: false };
  const mcpServers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null) return { ok: true, connected: false };
  const entry = (mcpServers as Record<string, unknown>)[params.name];
  if (!isWrapShape(entry)) return { ok: true, connected: false };
  const connected = isAlreadyWrapped(entry.command, entry.args) && entry.args[0] === 'http';
  return { ok: true, connected };
}
