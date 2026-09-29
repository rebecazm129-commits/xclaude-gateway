// Update of an existing Claude Code hook install on disk (updateCchook), the
// guarded write under it (claude-settings-write.ts) and the file-level
// capability read (readCchookHooksCheck). Temp paths only — the real
// ~/.claude and the real backups folder are never touched.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCchookHookEntry, cchookEventsFor } from '@xcg/shared/config';
import { installCchook, updateCchook } from '../../src/main/cchook-install.js';
import { isHookRegistered, readCchookHooksCheck } from '../../src/main/claude-code-detect.js';
import {
  CHANGED_DURING_UPDATE,
  MANAGED_EXTERNALLY,
  SETTINGS_BACKUPS_KEPT,
  backupSettings,
  readSettingsGuarded,
} from '../../src/main/claude-settings-write.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-cchook-update-'));
  tmpDirs.push(dir);
  return dir;
}
function settingsPath(content?: string): { path: string; backupDir: string } {
  const dir = tempDir();
  const path = join(dir, '.claude', 'settings.json');
  if (content !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }
  return { path, backupDir: join(dir, 'app', 'backups', 'claude-settings') };
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const FOREIGN_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash', args: ['-c', 'echo user-hook'] }] };
const OLD_INSTALL = JSON.stringify(
  {
    theme: 'dark',
    hooks: {
      PostToolUse: [FOREIGN_ENTRY, buildCchookHookEntry()],
      PostToolUseFailure: [buildCchookHookEntry()],
      SessionStart: [buildCchookHookEntry()],
      SessionEnd: [buildCchookHookEntry()],
      Stop: [FOREIGN_ENTRY],
    },
  },
  null,
  2,
);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const hooksOf = (p: string) => read(p)['hooks'] as Record<string, unknown[]>;
const ALL = cchookEventsFor('2.1.283');

describe('readCchookHooksCheck', () => {
  it('absent or invalid JSON → not_installed (never throws)', () => {
    expect(readCchookHooksCheck(settingsPath().path)).toEqual({ state: 'not_installed' });
    expect(readCchookHooksCheck(settingsPath('{ nope').path)).toEqual({ state: 'not_installed' });
  });

  it('an install from before elicitation → outdated, while isHookRegistered still says true', () => {
    const { path } = settingsPath(OLD_INSTALL);
    expect(readCchookHooksCheck(path)).toMatchObject({ state: 'outdated' });
    expect(isHookRegistered(path)).toBe(true); // meaning unchanged: the marker is there
  });

  it('with the events of an older Claude Code, the same file is up to date', () => {
    const { path } = settingsPath(OLD_INSTALL);
    expect(readCchookHooksCheck(path, cchookEventsFor('2.1.50'))).toEqual({ state: 'up_to_date' });
  });
});

describe('updateCchook', () => {
  it('adds the missing events; foreign hooks and other settings stay as they were', () => {
    const { path, backupDir } = settingsPath(OLD_INSTALL);
    const res = updateCchook({ settingsPath: path, backupDir, events: ALL });
    expect(res).toMatchObject({ ok: true, outcome: 'wrote', settingsPath: path });
    expect(readCchookHooksCheck(path)).toEqual({ state: 'up_to_date' });
    expect(read(path)['theme']).toBe('dark');
    expect(hooksOf(path)['PostToolUse']![0]).toEqual(FOREIGN_ENTRY);
    expect(hooksOf(path)['Stop']).toEqual([FOREIGN_ENTRY]);
    // No settings.json.bak any more: the copy lives in the backups folder.
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('Claude Code older than 2.1.76 or unknown: the elicitation events are not added', () => {
    for (const version of ['2.1.75', null]) {
      const { path, backupDir } = settingsPath(OLD_INSTALL);
      expect(updateCchook({ settingsPath: path, backupDir, events: cchookEventsFor(version) })).toMatchObject({
        ok: true,
        outcome: 'noop',
      });
      expect(hooksOf(path)['Elicitation']).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(OLD_INSTALL);
    }
  });

  it('idempotent: a second update is a noop, the file and the backups untouched', () => {
    const { path, backupDir } = settingsPath(OLD_INSTALL);
    updateCchook({ settingsPath: path, backupDir, events: ALL });
    const once = readFileSync(path, 'utf8');
    expect(updateCchook({ settingsPath: path, backupDir, events: ALL })).toMatchObject({ ok: true, outcome: 'noop' });
    expect(readFileSync(path, 'utf8')).toBe(once);
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it('a custom hook path is kept as it is; the missing events are still added', () => {
    const custom = { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/xcg-cchook', async: true }] };
    const settings = JSON.stringify({ hooks: { ...(JSON.parse(OLD_INSTALL) as { hooks: object }).hooks, SessionStart: [custom] } });
    const { path, backupDir } = settingsPath(settings);
    expect(updateCchook({ settingsPath: path, backupDir, events: ALL })).toMatchObject({ ok: true, outcome: 'wrote' });
    expect(hooksOf(path)['SessionStart']).toEqual([custom]);
    expect(readCchookHooksCheck(path)).toEqual({ state: 'outdated', issues: [{ event: 'SessionStart', problem: 'custom_path' }] });
  });

  it('invalid JSON is never overwritten, and nothing is backed up', () => {
    const { path, backupDir } = settingsPath('{ nope');
    expect(updateCchook({ settingsPath: path, backupDir, events: ALL }).ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{ nope');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('nothing of ours installed → error, nothing written (that is Install)', () => {
    const absent = settingsPath();
    expect(updateCchook({ settingsPath: absent.path, backupDir: absent.backupDir, events: ALL }).ok).toBe(false);
    expect(existsSync(absent.path)).toBe(false);
    const foreign = settingsPath(JSON.stringify({ hooks: { Stop: [FOREIGN_ENTRY] } }));
    const before = readFileSync(foreign.path, 'utf8');
    expect(updateCchook({ settingsPath: foreign.path, backupDir: foreign.backupDir, events: ALL }).ok).toBe(false);
    expect(readFileSync(foreign.path, 'utf8')).toBe(before);
  });
});

describe('managed externally: never written', () => {
  it('a symlinked settings.json', () => {
    const { path, backupDir } = settingsPath();
    const real = join(tempDir(), 'dotfiles-settings.json');
    writeFileSync(real, OLD_INSTALL);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(real, path);
    expect(updateCchook({ settingsPath: path, backupDir, events: ALL })).toMatchObject({ ok: false, error: MANAGED_EXTERNALLY, managed: { reason: 'symlink' } });
    expect(readFileSync(real, 'utf8')).toBe(OLD_INSTALL);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('not a regular file (a directory named settings.json)', () => {
    const { path, backupDir } = settingsPath();
    mkdirSync(path, { recursive: true });
    expect(updateCchook({ settingsPath: path, backupDir, events: ALL })).toMatchObject({ ok: false, error: MANAGED_EXTERNALLY, managed: { reason: 'not_regular' } });
  });

  it('owned by another user', () => {
    const { path } = settingsPath(OLD_INSTALL);
    const other = (process.getuid?.() ?? 501) + 1;
    expect(readSettingsGuarded(path, other)).toMatchObject({ ok: false, kind: 'managed', error: MANAGED_EXTERNALLY });
  });
});

describe('compare-before-swap', () => {
  it('a change to settings.json while updating aborts; the concurrent content survives, no temp left', () => {
    const { path, backupDir } = settingsPath(OLD_INSTALL);
    const concurrent = JSON.stringify({ ...JSON.parse(OLD_INSTALL), model: 'changed-meanwhile' });
    const res = updateCchook({
      settingsPath: path,
      backupDir,
      events: ALL,
      swapHooks: { beforeCompare: () => writeFileSync(path, concurrent) },
    });
    expect(res).toEqual({ ok: false, error: CHANGED_DURING_UPDATE });
    expect(readFileSync(path, 'utf8')).toBe(concurrent);
    expect(readdirSync(dirname(path)).filter((f) => f.includes('xcg-tmp'))).toEqual([]);
  });
});

describe('backups', () => {
  it('the exact bytes read, in a 0700 folder, as a 0600 file', () => {
    const { path, backupDir } = settingsPath(OLD_INSTALL);
    const res = updateCchook({ settingsPath: path, backupDir, events: ALL });
    expect(res.ok && res.backupPath).toBeTruthy();
    const copy = (res as { backupPath: string }).backupPath;
    expect(readFileSync(copy, 'utf8')).toBe(OLD_INSTALL);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  it(`rotation keeps the newest ${SETTINGS_BACKUPS_KEPT}`, () => {
    const { backupDir } = settingsPath();
    const bytes = Buffer.from('{}');
    for (let i = 0; i < 5; i++) backupSettings(bytes, backupDir, new Date(Date.UTC(2026, 8, 29, 10, 0, i)));
    expect(readdirSync(backupDir).sort()).toEqual([
      'settings-20260929T100002000Z.json',
      'settings-20260929T100003000Z.json',
      'settings-20260929T100004000Z.json',
    ]);
  });

  it('two copies in the same millisecond never overwrite each other', () => {
    const { backupDir } = settingsPath();
    const at = new Date(Date.UTC(2026, 8, 29, 10, 0, 0));
    const a = backupSettings(Buffer.from('a'), backupDir, at);
    const b = backupSettings(Buffer.from('b'), backupDir, at);
    expect(a.ok && b.ok).toBe(true);
    expect(readFileSync((a as { path: string }).path, 'utf8')).toBe('a');
    expect(readFileSync((b as { path: string }).path, 'utf8')).toBe('b');
  });

  it('if the copy fails, the settings are not updated', () => {
    const { path } = settingsPath(OLD_INSTALL);
    const blocker = join(tempDir(), 'not-a-dir');
    writeFileSync(blocker, 'x'); // a FILE where the backups folder should be
    const res = updateCchook({ settingsPath: path, backupDir: join(blocker, 'claude-settings'), events: ALL });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/could not back up Claude Code settings/);
    expect(readFileSync(path, 'utf8')).toBe(OLD_INSTALL);
  });
});

describe('install with the version gate', () => {
  it('an older or unknown Claude Code: Install leaves the elicitation events out', () => {
    for (const version of ['2.1.75', null]) {
      const { path } = settingsPath();
      expect(installCchook(path, cchookEventsFor(version))).toMatchObject({ ok: true, outcome: 'wrote' });
      expect(Object.keys(hooksOf(path))).toEqual(['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd']);
    }
  });

  it('2.1.76 or later: Install writes all six', () => {
    const { path } = settingsPath();
    installCchook(path, cchookEventsFor('2.1.76'));
    expect(readCchookHooksCheck(path)).toEqual({ state: 'up_to_date' });
  });
});
