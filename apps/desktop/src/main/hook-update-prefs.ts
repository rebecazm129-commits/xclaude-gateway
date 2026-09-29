// "Not now" for the Claude Code hook-update notice, kept in the app's
// settings.json under `claudeCodeHookUpdate`. One mark, tied to the SET of
// pending changes (hookUpdateKey): when that set changes, the notice shows
// again. Sources' small "Hook update available" state ignores it.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from '@xcg/shared/config';

import type { HookUpdatePrefs } from '../shared/types.js';
import { BASE_DIR, SETTINGS_FILENAME, readSettingsObject } from './retention.js';

const KEY = 'claudeCodeHookUpdate';

export function readHookUpdatePrefs(baseDir: string = BASE_DIR): HookUpdatePrefs {
  const raw = readSettingsObject(join(baseDir, SETTINGS_FILENAME))[KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const notNowKey = (raw as Record<string, unknown>)['notNowKey'];
  return typeof notNowKey === 'string' ? { notNowKey } : {};
}

/** "Not now": hide the notice until the set of pending changes differs. */
export function hookUpdateNotNow(key: string, baseDir: string = BASE_DIR): void {
  const path = join(baseDir, SETTINGS_FILENAME);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // Same cold-start seed as writeRetentionConfig: writeAtomic needs a target.
  if (!existsSync(path)) writeFileSync(path, '{}\n', { mode: 0o600 });
  const res = writeAtomic(path, { ...readSettingsObject(path), [KEY]: { notNowKey: key } });
  if (!res.ok) console.error(`hook-update-prefs: write failed (${res.error.kind})`);
}
