// "Dismiss" for the ~/.claude-* profile notice, kept in the app's settings.json
// under `claudeCodeProfilesDismissed`: the list of profile paths (as shown,
// "~/.claude-work") whose notice the user hid. Per path and for good — the
// folder is still there; the user said they know about it.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from '@xcg/shared/config';

import type { UnauditedClaudeProfile } from '../shared/types.js';
import { BASE_DIR, SETTINGS_FILENAME, readSettingsObject } from './retention.js';

const KEY = 'claudeCodeProfilesDismissed';

/** Only what the scan itself produces: "~/.claude-<name>", one level. */
export function isProfilePath(path: unknown): path is string {
  return typeof path === 'string' && /^~\/\.claude-[^/]+$/.test(path);
}

export function readDismissedProfiles(baseDir: string = BASE_DIR): string[] {
  const raw = readSettingsObject(join(baseDir, SETTINGS_FILENAME))[KEY];
  return Array.isArray(raw) ? raw.filter(isProfilePath) : [];
}

export function dismissProfile(path: string, baseDir: string = BASE_DIR): void {
  if (!isProfilePath(path)) return;
  const file = join(baseDir, SETTINGS_FILENAME);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // Same cold-start seed as hookUpdateNotNow: writeAtomic needs a target.
  if (!existsSync(file)) writeFileSync(file, '{}\n', { mode: 0o600 });
  const current = readDismissedProfiles(baseDir);
  if (current.includes(path)) return;
  const res = writeAtomic(file, { ...readSettingsObject(file), [KEY]: [...current, path].sort() });
  if (!res.ok) console.error(`profile-notice-prefs: write failed (${res.error.kind})`);
}

/** The profiles still to show: the scan minus the dismissed paths. */
export function visibleProfiles(
  profiles: readonly UnauditedClaudeProfile[],
  dismissed: readonly string[],
): UnauditedClaudeProfile[] {
  const hidden = new Set(dismissed);
  return profiles.filter((p) => !hidden.has(p.path));
}
