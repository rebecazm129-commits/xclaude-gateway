// Best-effort detection of Claude Code profiles xCLAUDE does not audit.
//
// Claude Code reads its user settings from $CLAUDE_CONFIG_DIR when that is set
// (documented pattern: `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`).
// An app launched from the Dock never sees that variable, so xCLAUDE only
// installs and watches ~/.claude. This scan only SUGGESTS: it looks for
// directories named ~/.claude-*/ that hold a settings.json without our hook,
// and the Claude Code tab says so. Nothing is installed, written or remembered.
//
// SCOPE, deliberately narrow:
//   - only direct children of the home folder named `.claude-*` that are
//     directories — never ~/.claude, never ~/.claude.json, never anywhere else;
//   - a candidate that resolves to ~/.claude (a symlinked directory, or a
//     settings.json that is a link to ~/.claude/settings.json) is the profile
//     we already audit, and is ignored;
//   - of each settings.json only the `hooks` section is kept, the rest of the
//     parsed document is dropped on the spot;
//   - anything unreadable, unparseable or oversized is skipped silently: a
//     suggestion that cannot be made is not an error.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cchookInstallSnippet, checkCchookHooks, type CchookEvent } from '@xcg/shared/config';

import type { UnauditedClaudeProfile } from '../shared/types.js';

/** Far above any real settings.json; above it the file is not read. */
const SETTINGS_MAX_BYTES = 1024 * 1024;

const PROFILE_PREFIX = '.claude-';

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The `hooks` section of a settings.json, or undefined when the file cannot
 *  be read or parsed. Nothing else of the document survives this function. */
function readHooksSection(path: string): { hooks: unknown } | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > SETTINGS_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { hooks: (parsed as Record<string, unknown>)['hooks'] };
  } catch {
    return undefined;
  }
}

export function findUnauditedClaudeProfiles(
  events: readonly CchookEvent[],
  deps: { home?: string } = {},
): UnauditedClaudeProfile[] {
  const home = deps.home ?? homedir();
  let names: string[];
  try {
    names = readdirSync(home).filter((n) => n.startsWith(PROFILE_PREFIX));
  } catch {
    return [];
  }
  const audited = realpathOrNull(join(home, '.claude'));
  const auditedSettings = realpathOrNull(join(home, '.claude', 'settings.json'));
  const snippet = JSON.stringify(cchookInstallSnippet(events), null, 2);

  const out: UnauditedClaudeProfile[] = [];
  for (const name of names.sort()) {
    const dir = join(home, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const real = realpathOrNull(dir);
    if (real === null || (audited !== null && real === audited)) continue;
    const settingsPath = join(dir, 'settings.json');
    const realSettings = realpathOrNull(settingsPath);
    if (realSettings === null || (auditedSettings !== null && realSettings === auditedSettings)) continue;
    const section = readHooksSection(settingsPath);
    if (section === undefined) continue;
    if (checkCchookHooks(section, { events }).state !== 'not_installed') continue;
    out.push({ path: `~/${name}`, snippet });
  }
  return out;
}

/** How long a scan result is reused. The status poll runs every 2 s; the
 *  home folder does not need listing that often for a suggestion. */
export const PROFILE_SCAN_TTL_MS = 60_000;

export interface ProfileScanCache {
  /** The cached result while it is younger than the TTL and was computed for
   *  the same events (the snippet depends on them); otherwise a fresh scan. */
  get(events: readonly CchookEvent[]): UnauditedClaudeProfile[];
  /** The next get() scans again (opening the Claude Code tab). */
  invalidate(): void;
}

export function createProfileScanCache(
  opts: {
    ttlMs?: number;
    now?: () => number;
    scan?: (events: readonly CchookEvent[]) => UnauditedClaudeProfile[];
  } = {},
): ProfileScanCache {
  const ttlMs = opts.ttlMs ?? PROFILE_SCAN_TTL_MS;
  const now = opts.now ?? Date.now;
  const scan = opts.scan ?? ((events: readonly CchookEvent[]) => findUnauditedClaudeProfiles(events));
  let last: { at: number; key: string; value: UnauditedClaudeProfile[] } | null = null;
  return {
    get(events) {
      const key = events.join(',');
      const t = now();
      if (last !== null && last.key === key && t - last.at < ttlMs) return last.value;
      const value = scan(events);
      last = { at: t, key, value };
      return value;
    },
    invalidate() {
      last = null;
    },
  };
}
