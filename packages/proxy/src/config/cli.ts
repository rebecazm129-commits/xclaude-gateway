// Config CLI entry — argv subcommand dispatcher for xcg-config
// (Milestone 4 Phase 4.2 — scaffolding). Parses subcommand + flags via
// node:util parseArgs, dispatches to status/install/uninstall handlers
// as stubs that emit valid JSON with schema:1. Real IO (parseConfig +
// applyWrap/unwrap + atomic write + backup + xcgPath resolution) lands
// in F4.3. Contract frozen in Bitácora ficha 367242b46fa781c299d5e7f303b971fc.

import { parseArgs } from 'node:util';

// --- Defaults ---

const DEFAULT_CONFIG_PATH =
  `${process.env.HOME ?? ''}/Library/Application Support/Claude/claude_desktop_config.json`;

// --- Exit codes (P5 frozen) ---

const EXIT_OK = 0;
const EXIT_GENERIC_ERROR = 1;
const EXIT_USAGE_OR_CORRUPT = 2;

// --- Output formatters ---

type OutputFormat = 'json' | 'human';

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitHumanStatus(payload: {
  schema: number;
  config_path: string;
  entries: unknown[];
  summary: { wrappable: number; already_wrapped: number; skipped: unknown[] };
}): void {
  process.stdout.write(
    `xcg-config status\n` +
      `  config: ${payload.config_path}\n` +
      `  wrappable: ${payload.summary.wrappable}\n` +
      `  already wrapped: ${payload.summary.already_wrapped}\n` +
      `  skipped: ${payload.summary.skipped.length}\n`,
  );
}

// --- Handlers (F4.2: stubs only; real IO in F4.3) ---

interface CommonOptions {
  configPath: string;
  output: OutputFormat;
  xcgPath: string | undefined;
}

function handleStatus(opts: CommonOptions): number {
  // F4.3 will: parseConfig(opts.configPath) -> compute WrapPlan summary.
  const payload = {
    schema: 1,
    config_path: opts.configPath,
    entries: [] as unknown[],
    summary: { wrappable: 0, already_wrapped: 0, skipped: [] as unknown[] },
  };
  if (opts.output === 'human') {
    emitHumanStatus(payload);
  } else {
    emitJson(payload);
  }
  return EXIT_OK;
}

function handleInstall(
  opts: CommonOptions,
  mode: 'dry-run' | 'yes',
): number {
  // F4.3 will: parseConfig -> applyWrap(raw, plan, xcgPath) ->
  //           if mode==='dry-run' return plan; else backup + atomic write.
  const payload = {
    schema: 1,
    config_path: opts.configPath,
    mode,
    outcome: 'noop' as const,
    plan: { entries: [] as unknown[] },
  };
  if (opts.output === 'human') {
    process.stdout.write(`xcg-config install (${mode}): noop (scaffold)\n`);
  } else {
    emitJson(payload);
  }
  return EXIT_OK;
}

function handleUninstall(
  opts: CommonOptions,
  mode: 'dry-run' | 'yes',
): number {
  // F4.3 will: parseConfig -> unwrap(raw) ->
  //           if mode==='dry-run' return plan; else backup + atomic write.
  const payload = {
    schema: 1,
    config_path: opts.configPath,
    mode,
    outcome: 'noop' as const,
  };
  if (opts.output === 'human') {
    process.stdout.write(`xcg-config uninstall (${mode}): noop (scaffold)\n`);
  } else {
    emitJson(payload);
  }
  return EXIT_OK;
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

// --- Argv parsing + dispatch ---

function main(argv: string[]): number {
  // Subcommand is argv[2] in raw process.argv (node, script, subcmd, ...flags).
  // We accept the raw argv slice from index 2 to keep this testable.
  const subcommand = argv[0];
  const rest = argv.slice(1);

  // Common flags shared by every subcommand.
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
    process.stderr.write(
      `xcg-config: ${(err as Error).message}\n`,
    );
    return EXIT_USAGE_OR_CORRUPT;
  }

  const v = parsed.values;
  const opts: CommonOptions = {
    configPath: (v['config-path'] as string | undefined) ?? DEFAULT_CONFIG_PATH,
    output: v.human === true ? 'human' : 'json',
    xcgPath: v['xcg-path'] as string | undefined,
  };
  const isDryRun = v['dry-run'] === true;
  const isYes = v.yes === true;

  switch (subcommand) {
    case 'status':
      return handleStatus(opts);
    case 'install':
      if (!isDryRun && !isYes) return dieMissingMode('install');
      return handleInstall(opts, isDryRun ? 'dry-run' : 'yes');
    case 'uninstall':
      if (!isDryRun && !isYes) return dieMissingMode('uninstall');
      return handleUninstall(opts, isDryRun ? 'dry-run' : 'yes');
    default:
      return dieUnknownSubcommand(subcommand);
  }
}

process.exit(main(process.argv.slice(2)));
