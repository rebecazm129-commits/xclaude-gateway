// Claude Code environment probes (F1.3c). Read-only over the user's home:
// detectClaudeCode() answers "is Claude Code on this machine" (per-process
// cached — an install mid-session shows up on next app launch, accepted);
// isHookRegistered() answers "is OUR capture hook wired into
// ~/.claude/settings.json" (uncached: the file can change under us and the
// 2s status poll is the freshness mechanism). Binary resolution mirrors
// resolveNpxPath (selftest-runner.ts): PATH walk + Homebrew/local fallbacks.
// Version probing is F1.3d.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Marker string that identifies our hook entry inside settings.json — the
 *  registered command invokes the xcg-cchook launcher, so its path (or any
 *  future form of the entry) always contains this token. */
export const CCHOOK_MARKER = 'xcg-cchook';

export interface ClaudeCodeDetectDeps {
  /** Override for tests; default ~/.claude. */
  claudeDir?: string;
  /** Override for tests; default process.env.PATH. */
  pathEnv?: string;
  /** Override for tests; default /usr/local/bin + /opt/homebrew/bin. */
  fallbackBinDirs?: readonly string[];
}

const DEFAULT_FALLBACK_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin'];

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function resolveClaudeBinary(pathEnv: string, fallbackBinDirs: readonly string[]): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of fallbackBinDirs) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Cached only on the dep-less (production) call: tests pass deps and always
// probe fresh, so temp-dir fixtures never fight the cache.
let cachedInstalled: boolean | null = null;

export function detectClaudeCode(deps: ClaudeCodeDetectDeps = {}): { installed: boolean } {
  const usingDefaults =
    deps.claudeDir === undefined && deps.pathEnv === undefined && deps.fallbackBinDirs === undefined;
  if (usingDefaults && cachedInstalled !== null) return { installed: cachedInstalled };

  const claudeDir = deps.claudeDir ?? join(homedir(), '.claude');
  const pathEnv = deps.pathEnv ?? process.env['PATH'] ?? '';
  const fallbackBinDirs = deps.fallbackBinDirs ?? DEFAULT_FALLBACK_BIN_DIRS;
  const installed = existsSync(claudeDir) || resolveClaudeBinary(pathEnv, fallbackBinDirs) !== null;

  if (usingDefaults) cachedInstalled = installed;
  return { installed };
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
