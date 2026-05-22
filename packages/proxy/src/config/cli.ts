// Config CLI entry — argv subcommand dispatcher for xcg-config
// (Milestone 4 Phase 4.3). Composes parseConfig (F1) + applyWrap/unwrap
// (F2) + atomic write with .bak backup (P6) + xcgPath resolution by
// inspecting process.argv[1] (P7). Pure handlers (runStatus, runInstall,
// runUninstall) return { exitCode, payload } so they can be tested
// without spawning the bundle. main() is thin: parses argv, dispatches,
// emits output, exits. Contract frozen in Bitácora ficha
// 367242b46fa781c299d5e7f303b971fc.

import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  applyWrap,
  CLAUDE_DESKTOP_CONFIG_PATH,
  parseConfig,
  STABLE_XCG_PROXY_PATH,
  unwrap,
  writeAtomic,
  type ParseError,
  type WrapPlanEntry,
  type WriteAtomicError,
} from '@xcg/shared/config';

// --- Defaults (canonical paths re-exported from @xcg/shared/config) ---

const DEFAULT_CONFIG_PATH = CLAUDE_DESKTOP_CONFIG_PATH;
const STABLE_SYMLINK_PATH = STABLE_XCG_PROXY_PATH;

// --- Exit codes (P5 frozen) ---

const EXIT_OK = 0;
const EXIT_GENERIC_ERROR = 1;
const EXIT_USAGE_OR_CORRUPT = 2;

// --- xcgPath resolution (P7) ---

// Detect dev-vs-packaged by inspecting where the bundle lives.
// Packaged: bundle is at <.app>/Contents/Resources/proxy/dist/xcg-config.cjs
//   -> xcgPath is the stable symlink under ~/Library/...
// Dev: bundle is at <repo>/packages/proxy/dist/xcg-config.cjs
//   -> xcgPath is the absolute path to <repo>/packages/proxy/bin/xcg-proxy
export function resolveXcgPath(bundlePath: string): string {
  const dir = dirname(resolve(bundlePath));
  if (dir.endsWith('.app/Contents/Resources/proxy/dist')) {
    return STABLE_SYMLINK_PATH;
  }
  // Dev mode: bundle is at <something>/packages/proxy/dist/. Resolve
  // sibling bin/xcg-proxy.
  return resolve(dir, '..', 'bin', 'xcg-proxy');
}

// --- Output formatters ---

type OutputFormat = 'json' | 'human';

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// --- Atomic write helpers (P6.c) ---

// Maps a ParseError to the public JSON error shape used in all responses.
function parseErrorToPayload(err: ParseError): {
  schema: 1;
  ok: false;
  error: { kind: ParseError['kind']; detail?: string };
} {
  if (err.kind === 'not-found') {
    return { schema: 1, ok: false, error: { kind: 'not-found' } };
  }
  return {
    schema: 1,
    ok: false,
    error: { kind: err.kind, detail: err.detail },
  };
}

// Maps a WriteAtomicError (permission / io) into the same JSON error shape
// the CLI uses for ParseError. Both are surfaced under error.kind: 'unreadable'
// from the consumer's perspective (the .bak/config write path is the same
// disk surface as reading the config); detail preserves the specific cause.
function writeAtomicErrorToPayload(err: WriteAtomicError): {
  schema: 1;
  ok: false;
  error: { kind: 'unreadable'; detail: string };
} {
  return {
    schema: 1,
    ok: false,
    error: { kind: 'unreadable', detail: `${err.kind}: ${err.detail}` },
  };
}

// --- Plan serialization for output ---

function entryToJson(entry: WrapPlanEntry): Record<string, unknown> {
  if (entry.kind === 'wrappable') {
    return { kind: 'wrappable', name: entry.name };
  }
  return { kind: 'skipped', name: entry.name, reason: entry.reason };
}

function summarize(entries: readonly WrapPlanEntry[]): {
  wrappable: number;
  already_wrapped: number;
  skipped_other: number;
} {
  let wrappable = 0;
  let already_wrapped = 0;
  let skipped_other = 0;
  for (const e of entries) {
    if (e.kind === 'wrappable') wrappable++;
    else if (e.reason === 'already-wrapped') already_wrapped++;
    else skipped_other++;
  }
  return { wrappable, already_wrapped, skipped_other };
}

// --- Pure handlers (testable without bundle) ---

export interface RunOptions {
  configPath: string;
  xcgPath: string;
}

export interface RunResult {
  exitCode: number;
  payload: Record<string, unknown>;
}

export function runStatus(opts: RunOptions): RunResult {
  const result = parseConfig(opts.configPath);
  if (!result.ok) {
    if (result.error.kind === 'not-found') {
      return {
        exitCode: EXIT_OK,
        payload: {
          schema: 1,
          ok: true,
          config_present: false,
          config_path: opts.configPath,
          entries: [],
          summary: { wrappable: 0, already_wrapped: 0, skipped_other: 0 },
        },
      };
    }
    return {
      exitCode: EXIT_USAGE_OR_CORRUPT,
      payload: parseErrorToPayload(result.error),
    };
  }
  return {
    exitCode: EXIT_OK,
    payload: {
      schema: 1,
      ok: true,
      config_present: true,
      config_path: opts.configPath,
      entries: result.plan.entries.map(entryToJson),
      summary: summarize(result.plan.entries),
    },
  };
}

export function runInstall(
  opts: RunOptions,
  mode: 'dry-run' | 'yes',
): RunResult {
  const result = parseConfig(opts.configPath);
  if (!result.ok) {
    if (result.error.kind === 'not-found') {
      return {
        exitCode: EXIT_GENERIC_ERROR,
        payload: {
          schema: 1,
          ok: false,
          error: {
            kind: 'not-found',
            detail:
              'claude_desktop_config.json not found. Open Claude Desktop and add at least one MCP server first, then re-run xcg-config install.',
          },
        },
      };
    }
    return {
      exitCode: EXIT_USAGE_OR_CORRUPT,
      payload: parseErrorToPayload(result.error),
    };
  }

  const wrapped = applyWrap(result.raw, result.plan, opts.xcgPath);
  const summary = summarize(result.plan.entries);
  const isNoop = summary.wrappable === 0;

  if (mode === 'dry-run') {
    return {
      exitCode: EXIT_OK,
      payload: {
        schema: 1,
        ok: true,
        mode: 'dry-run',
        config_path: opts.configPath,
        xcg_path: opts.xcgPath,
        outcome: isNoop ? 'noop' : 'would_write',
        entries: result.plan.entries.map(entryToJson),
        summary,
      },
    };
  }

  // mode === 'yes': commit
  let outcome: 'wrote' | 'noop' = 'noop';
  if (!isNoop) {
    const wr = writeAtomic(opts.configPath, wrapped);
    if (!wr.ok) {
      return {
        exitCode: EXIT_USAGE_OR_CORRUPT,
        payload: writeAtomicErrorToPayload(wr.error),
      };
    }
    outcome = 'wrote';
  }
  return {
    exitCode: EXIT_OK,
    payload: {
      schema: 1,
      ok: true,
      mode: 'yes',
      config_path: opts.configPath,
      xcg_path: opts.xcgPath,
      outcome,
      entries: result.plan.entries.map(entryToJson),
      summary,
    },
  };
}

export function runUninstall(
  opts: RunOptions,
  mode: 'dry-run' | 'yes',
): RunResult {
  const result = parseConfig(opts.configPath);
  if (!result.ok) {
    if (result.error.kind === 'not-found') {
      return {
        exitCode: EXIT_GENERIC_ERROR,
        payload: {
          schema: 1,
          ok: false,
          error: {
            kind: 'not-found',
            detail:
              'claude_desktop_config.json not found. Nothing to uninstall.',
          },
        },
      };
    }
    return {
      exitCode: EXIT_USAGE_OR_CORRUPT,
      payload: parseErrorToPayload(result.error),
    };
  }

  const summary = summarize(result.plan.entries);
  const isNoop = summary.already_wrapped === 0;
  const unwrapped = unwrap(result.raw);

  if (mode === 'dry-run') {
    return {
      exitCode: EXIT_OK,
      payload: {
        schema: 1,
        ok: true,
        mode: 'dry-run',
        config_path: opts.configPath,
        outcome: isNoop ? 'noop' : 'would_write',
        summary,
      },
    };
  }

  let outcome: 'wrote' | 'noop' = 'noop';
  if (!isNoop) {
    const wr = writeAtomic(opts.configPath, unwrapped);
    if (!wr.ok) {
      return {
        exitCode: EXIT_USAGE_OR_CORRUPT,
        payload: writeAtomicErrorToPayload(wr.error),
      };
    }
    outcome = 'wrote';
  }
  return {
    exitCode: EXIT_OK,
    payload: {
      schema: 1,
      ok: true,
      mode: 'yes',
      config_path: opts.configPath,
      outcome,
      summary,
    },
  };
}

// --- Human-readable output ---

function emitHuman(result: RunResult, kind: 'status' | 'install' | 'uninstall'): void {
  const p = result.payload;
  if (p.ok === false) {
    process.stderr.write(
      `xcg-config ${kind}: ${(p.error as { kind: string }).kind}${(p.error as { detail?: string }).detail ? `: ${(p.error as { detail?: string }).detail}` : ''}\n`,
    );
    return;
  }
  if (kind === 'status') {
    const s = p.summary as { wrappable: number; already_wrapped: number; skipped_other: number };
    process.stdout.write(
      `xcg-config status\n` +
        `  config: ${p.config_path}\n` +
        `  config present: ${p.config_present}\n` +
        `  wrappable: ${s.wrappable}\n` +
        `  already wrapped: ${s.already_wrapped}\n` +
        `  skipped (other): ${s.skipped_other}\n`,
    );
  } else {
    process.stdout.write(
      `xcg-config ${kind} (${p.mode}): ${p.outcome}\n`,
    );
  }
}

// --- Error helpers ---

function dieMissingMode(subcommand: 'install' | 'uninstall'): number {
  process.stderr.write(
    `xcg-config ${subcommand} requires one of:\n` +
      `  --dry-run   show the wrap plan as JSON, do not write\n` +
      `  --yes       execute: write claude_desktop_config.json (with .bak backup)\n` +
      `There is no interactive prompt by design. For a visual confirmation flow,\n` +
      `open xCLAUDE Gateway.app.\n`,
  );
  return EXIT_USAGE_OR_CORRUPT;
}

function dieUnknownSubcommand(arg: string | undefined): number {
  process.stderr.write(
    `xcg-config: unknown subcommand: ${arg ?? '(none)'}\n` +
      `usage: xcg-config <install|uninstall|status> [--config-path <path>] [--json|--human] [--dry-run|--yes] [--xcg-path <path>]\n`,
  );
  return EXIT_USAGE_OR_CORRUPT;
}

// --- main ---

export function main(argv: string[]): number {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        'config-path': { type: 'string' },
        json: { type: 'boolean' },
        human: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        'xcg-path': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`xcg-config: ${(err as Error).message}\n`);
    return EXIT_USAGE_OR_CORRUPT;
  }

  const v = parsed.values;
  const opts: RunOptions = {
    configPath: (v['config-path'] as string | undefined) ?? DEFAULT_CONFIG_PATH,
    xcgPath:
      (v['xcg-path'] as string | undefined) ??
      resolveXcgPath(process.argv[1] ?? ''),
  };
  const output: OutputFormat = v.human === true ? 'human' : 'json';
  const isDryRun = v['dry-run'] === true;
  const isYes = v.yes === true;

  let result: RunResult;
  let kind: 'status' | 'install' | 'uninstall';
  switch (subcommand) {
    case 'status':
      kind = 'status';
      result = runStatus(opts);
      break;
    case 'install':
      kind = 'install';
      if (!isDryRun && !isYes) return dieMissingMode('install');
      result = runInstall(opts, isDryRun ? 'dry-run' : 'yes');
      break;
    case 'uninstall':
      kind = 'uninstall';
      if (!isDryRun && !isYes) return dieMissingMode('uninstall');
      result = runUninstall(opts, isDryRun ? 'dry-run' : 'yes');
      break;
    default:
      return dieUnknownSubcommand(subcommand);
  }

  if (output === 'human') {
    emitHuman(result, kind);
  } else {
    emitJson(result.payload);
  }
  return result.exitCode;
}
