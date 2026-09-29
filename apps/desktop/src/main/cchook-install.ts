// Install / Update / Uninstall of the Claude Code capture hook in
// ~/.claude/settings.json (F1.3d; Update for existing installs). Owns the fs
// around the pure merge/update/remove from @xcg/shared/config.
//
// Every write goes through the guarded path (claude-settings-write.ts):
//   - a symlinked, non-regular or foreign-owned settings file is managed
//     externally and never written;
//   - a settings.json that fails to parse is NEVER overwritten;
//   - the exact bytes read are copied to backups/claude-settings/ first (the
//     newest 3 kept) — no copy, no write;
//   - compare-before-swap: the write aborts if the file changed meanwhile;
//   - the result is re-read and verified.
// A settings.json that does not exist yet is created (Install only) without
// racing a file that appears meanwhile. Only entries carrying our marker are
// ever changed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CCHOOK_EVENTS,
  cchookInstallSnippet,
  cchookUpdateSnippet,
  checkCchookHooks,
  fixableCchookIssues,
  mergeCchookHooks,
  removeCchookHooks,
  updateCchookHooks,
  type CchookEvent,
  type CchookHooksResult,
} from '@xcg/shared/config';

import type { CchookInstallResult, CchookManagedSettings } from '../shared/types.js';
import {
  backupSettings,
  createSettingsIfAbsent,
  defaultSettingsBackupDir,
  readSettingsGuarded,
  swapSettingsIfUnchanged,
  type GuardedRead,
  type SwapHooks,
} from './claude-settings-write.js';

function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

const NOT_INSTALLED = 'The Claude Code hook is not installed.';

const snippetText = (snippet: object): string => JSON.stringify(snippet, null, 2);

// What the managed file holds, read THROUGH the symlink (read only — nothing
// is ever written through it). Unreadable or invalid → null.
function readThrough(settingsPath: string): unknown {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// The managed-externally description for a failed guarded read. `mode`
// decides the snippet: Install offers every supported event; Update only
// what is missing or outdated (falling back to the install snippet if the
// file cannot be read).
function managedInfo(
  read: Extract<GuardedRead, { kind: 'managed' }>,
  settingsPath: string,
  events: readonly CchookEvent[],
  mode: 'install' | 'update',
): CchookManagedSettings {
  const current = mode === 'update' ? readThrough(settingsPath) : null;
  const snippet =
    current !== null && checkCchookHooks(current, { events }).state !== 'not_installed'
      ? cchookUpdateSnippet(current, events)
      : cchookInstallSnippet(events);
  return {
    reason: read.reason,
    ...(read.target !== undefined ? { target: read.target } : {}),
    snippet: snippetText(snippet),
  };
}

/** For cchook:status: null when settings.json is ours to write (or absent);
 *  otherwise why not, and the snippet to paste — the update one when our hook
 *  is already there, the install one when it is not. */
export function managedSettingsStatus(
  settingsPath: string = defaultSettingsPath(),
  events: readonly CchookEvent[] = CCHOOK_EVENTS,
): CchookManagedSettings | null {
  const read = readSettingsGuarded(settingsPath);
  return read.ok || read.kind !== 'managed' ? null : managedInfo(read, settingsPath, events, 'update');
}

export interface SettingsWriteDeps {
  /** Where the copies go; default backups/claude-settings/ in our data dir. */
  backupDir?: string;
  now?: Date;
  swapHooks?: SwapHooks;
}

// One guarded read → transform → backup → swap → verify pass.
function guardedWrite(
  settingsPath: string,
  transform: (settings: unknown) => CchookHooksResult | { error: string },
  verify: (settings: unknown) => boolean,
  deps: SettingsWriteDeps,
): CchookInstallResult {
  const read = readSettingsGuarded(settingsPath);
  if (!read.ok) return { ok: false, error: read.error };

  const next = transform(read.settings);
  if ('error' in next) return { ok: false, error: next.error };
  if (!next.changed) return { ok: true, outcome: 'noop', settingsPath };

  const backup = backupSettings(read.bytes, deps.backupDir ?? defaultSettingsBackupDir(), deps.now ?? new Date());
  if (!backup.ok) return { ok: false, error: backup.error };

  const swap = swapSettingsIfUnchanged(settingsPath, read.hash, next.settings, read.mode, deps.swapHooks);
  if (!swap.ok) return { ok: false, error: swap.error };

  const after = readSettingsGuarded(settingsPath);
  if (!after.ok || !verify(after.settings)) {
    return {
      ok: false,
      error: `Claude Code settings did not verify after the change. Your previous settings are backed up at ${backup.path}.`,
    };
  }
  return { ok: true, outcome: 'wrote', settingsPath, backupPath: backup.path };
}

// Every considered event has an entry of ours (a manual or custom one counts:
// Install adopts, it does not rewrite).
const hasEveryEvent = (events: readonly CchookEvent[]) => (settings: unknown): boolean => {
  const check = checkCchookHooks(settings, { events });
  return check.state === 'up_to_date' || (check.state === 'outdated' && !check.issues.some((i) => i.problem === 'missing'));
};

// `events`: the events this Claude Code supports (cchookEventsFor) — the two
// elicitation events are left out below 2.1.76 or when the version is unknown.
export function installCchook(
  settingsPath: string = defaultSettingsPath(),
  events: readonly CchookEvent[] = CCHOOK_EVENTS,
  deps: SettingsWriteDeps = {},
): CchookInstallResult {
  const read = readSettingsGuarded(settingsPath);
  if (!read.ok && read.kind === 'managed') {
    return { ok: false, error: read.error, managed: managedInfo(read, settingsPath, events, 'install') };
  }
  if (!read.ok && read.kind === 'absent') {
    // Nothing to back up: the file is created, only if it still is absent.
    const { settings } = mergeCchookHooks({}, { events });
    const created = createSettingsIfAbsent(settingsPath, settings);
    if (!created.ok) return { ok: false, error: created.error };
    const after = readSettingsGuarded(settingsPath);
    if (!after.ok || !hasEveryEvent(events)(after.settings)) {
      return { ok: false, error: 'Claude Code settings did not verify after the change.' };
    }
    return { ok: true, outcome: 'wrote', settingsPath };
  }
  return guardedWrite(settingsPath, (s) => mergeCchookHooks(s, { events }), hasEveryEvent(events), deps);
}

// Update of an EXISTING install (new hook events, async, --event), only on an
// explicit click — never automatic. A custom hook path is never replaced, and
// events this Claude Code does not support (`events`) are not added. With no
// hook of ours in the file there is nothing to update: that is Install's job.
export interface UpdateCchookDeps extends SettingsWriteDeps {
  settingsPath?: string;
  /** Events this Claude Code supports (cchookEventsFor). Default: all. */
  events?: readonly CchookEvent[];
}

export function updateCchook(deps: UpdateCchookDeps = {}): CchookInstallResult {
  const settingsPath = deps.settingsPath ?? defaultSettingsPath();
  const opts = { events: deps.events ?? CCHOOK_EVENTS };
  const read = readSettingsGuarded(settingsPath);
  if (!read.ok && read.kind === 'absent') return { ok: false, error: NOT_INSTALLED };
  if (!read.ok && read.kind === 'managed') {
    return { ok: false, error: read.error, managed: managedInfo(read, settingsPath, opts.events, 'update') };
  }
  return guardedWrite(
    settingsPath,
    (s) => (checkCchookHooks(s, opts).state === 'not_installed' ? { error: NOT_INSTALLED } : updateCchookHooks(s, opts)),
    // Every fixable issue is gone (a custom path may remain — never ours to
    // replace).
    (s) => fixableCchookIssues(checkCchookHooks(s, opts)).length === 0,
    deps,
  );
}

export function uninstallCchook(
  settingsPath: string = defaultSettingsPath(),
  deps: SettingsWriteDeps = {},
): CchookInstallResult {
  const read = readSettingsGuarded(settingsPath);
  if (!read.ok && read.kind === 'absent') return { ok: true, outcome: 'noop', settingsPath };
  return guardedWrite(
    settingsPath,
    (s) => removeCchookHooks(s),
    (s) => checkCchookHooks(s).state === 'not_installed',
    deps,
  );
}
