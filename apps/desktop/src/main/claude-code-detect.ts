// Claude Code environment probes (F1.3c). Read-only over the user's home:
// detectClaudeCode() answers "is Claude Code on this machine" (per-process
// cached — an install mid-session shows up on next app launch, accepted);
// isHookRegistered() answers "is OUR capture hook wired into
// ~/.claude/settings.json" (uncached: the file can change under us and the
// 2s status poll is the freshness mechanism). Binary resolution mirrors
// resolveNpxPath (selftest-runner.ts): PATH walk + Homebrew/local fallbacks.
// Version probing is F1.3d.

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { checkCchookHooks, type CchookEvent, type CchookHooksCheck } from '@xcg/shared/config';

/** Marker string that identifies our hook entry inside settings.json — the
 *  registered command invokes the xcg-cchook launcher, so its path (or any
 *  future form of the entry) always contains this token. */
export const CCHOOK_MARKER = 'xcg-cchook';

export interface ClaudeCodeDetectDeps {
  /** Override for tests; default ~/.claude. */
  claudeDir?: string;
  /** Override for tests; default process.env.PATH. */
  pathEnv?: string;
  /** Override for tests; default knownClaudeBinDirs(home). */
  fallbackBinDirs?: readonly string[];
  /** Override for tests; default the user's home (for knownClaudeBinDirs). */
  home?: string;
}

/**
 * Where Claude Code's `claude` usually lives when it is not on the app's PATH
 * (a Finder-launched app gets launchd's minimal PATH), in the order they are
 * tried after the PATH walk: npm with a user prefix, the native installer,
 * the legacy local install, Homebrew on Apple silicon, then /usr/local.
 */
export function knownClaudeBinDirs(home: string = homedir()): string[] {
  return [
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

// A regular file we may execute (symlinks followed — npm and Homebrew install
// `claude` as one). Read-only probe: nothing is run here.
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `claude` binary: PATH first, then the known locations, in order. The
 *  first executable found wins. */
export function resolveClaudeBinary(pathEnv: string, fallbackBinDirs: readonly string[]): string | null {
  for (const dir of [...pathEnv.split(delimiter), ...fallbackBinDirs]) {
    if (dir === '') continue;
    const candidate = join(dir, 'claude');
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

// Cached only on the dep-less (production) call: tests pass deps and always
// probe fresh, so temp-dir fixtures never fight the cache.
let cachedInstalled: boolean | null = null;

export function detectClaudeCode(deps: ClaudeCodeDetectDeps = {}): { installed: boolean } {
  const usingDefaults =
    deps.claudeDir === undefined &&
    deps.pathEnv === undefined &&
    deps.fallbackBinDirs === undefined &&
    deps.home === undefined;
  if (usingDefaults && cachedInstalled !== null) return { installed: cachedInstalled };

  const claudeDir = deps.claudeDir ?? join(deps.home ?? homedir(), '.claude');
  const pathEnv = deps.pathEnv ?? process.env['PATH'] ?? '';
  const fallbackBinDirs = deps.fallbackBinDirs ?? knownClaudeBinDirs(deps.home);
  const installed = existsSync(claudeDir) || resolveClaudeBinary(pathEnv, fallbackBinDirs) !== null;

  if (usingDefaults) cachedInstalled = installed;
  return { installed };
}

// --- installed Claude Code version ----------------------------------------------
//
// `claude --version` on the binary resolveClaudeBinary finds (PATH walk, then
// knownClaudeBinDirs — the same resolution detectClaudeCode uses). Local only: no network, 5s timeout, DISABLE_AUTOUPDATER set, and the
// binary's own directory plus the fallbacks put on PATH so a `#!/usr/bin/env
// node` launcher finds node even from the Finder-launched app. Anything that
// fails → null (unknown), which callers treat as "too old". Cached per binary
// path + mtime: the 2s status poll does one stat, and an upgrade of Claude
// Code (new mtime) is picked up on the next poll.

export interface ClaudeVersionDeps extends ClaudeCodeDetectDeps {
  /** Override for tests: runs the binary, resolves its stdout. */
  run?: (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

/** "2.1.283 (Claude Code)" → "2.1.283"; anything else → null. */
export function parseClaudeVersion(stdout: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`;
}

function runBinary(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, [...args], { timeout: 5_000, env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

let versionCache: { key: string; version: string | null } | null = null;

export async function readClaudeCodeVersion(deps: ClaudeVersionDeps = {}): Promise<string | null> {
  const pathEnv = deps.pathEnv ?? process.env['PATH'] ?? '';
  const fallbackBinDirs = deps.fallbackBinDirs ?? knownClaudeBinDirs(deps.home);
  const binary = resolveClaudeBinary(pathEnv, fallbackBinDirs);
  if (binary === null) return null;
  let key: string;
  try {
    key = `${binary}|${statSync(binary).mtimeMs}`;
  } catch {
    return null;
  }
  if (deps.run === undefined && versionCache?.key === key) return versionCache.version;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISABLE_AUTOUPDATER: '1',
    PATH: [dirname(binary), ...fallbackBinDirs, pathEnv].filter((p) => p !== '').join(delimiter),
  };
  let version: string | null;
  try {
    version = parseClaudeVersion(await (deps.run ?? runBinary)(binary, ['--version'], env));
  } catch {
    version = null;
  }
  if (deps.run === undefined) versionCache = { key, version };
  return version;
}

// Tolerant read: file absent, unreadable or invalid JSON → false (a corrupt
// settings.json must degrade to "not registered", never throw into the IPC
// handler). Marker search over the raw text AFTER a successful parse: we only
// claim "registered" for a settings file Claude Code itself could load.
export function isHookRegistered(settingsPath: string = claudeSettingsPath()): boolean {
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    JSON.parse(raw);
    return raw.includes(CCHOOK_MARKER);
  } catch {
    return false;
  }
}

// Capability, not marker: event by event, is our hook there as this build
// writes it (checkCchookHooks). isHookRegistered keeps its meaning — "the
// marker is somewhere" — for the Sources row and the integrity check; this is
// what says an existing install lacks events this build added. Same tolerant
// read: absent, unreadable or invalid JSON → not_installed, never a throw.
export function readCchookHooksCheck(
  settingsPath: string = claudeSettingsPath(),
  events?: readonly CchookEvent[],
): CchookHooksCheck {
  try {
    return checkCchookHooks(JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown, events !== undefined ? { events } : {});
  } catch {
    return { state: 'not_installed' };
  }
}
