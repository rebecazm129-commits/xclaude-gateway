// settings.json managed externally (a symlink, not a regular file, or owned by
// another user): Install and Update write nothing — never through the symlink
// — and return what the notice needs: the reason, the resolved target
// (symlink only) and a snippet with only xCLAUDE's entries.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCchookHookEntry, cchookEventsFor } from '@xcg/shared/config';
import { installCchook, managedSettingsStatus, updateCchook } from '../../src/main/cchook-install.js';
import { readSettingsGuarded } from '../../src/main/claude-settings-write.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] };
const OLD_INSTALL = JSON.stringify({
  model: 'claude-fable-5',
  hooks: {
    PostToolUse: [FOREIGN, buildCchookHookEntry()],
    PostToolUseFailure: [buildCchookHookEntry()],
    SessionStart: [buildCchookHookEntry()],
    SessionEnd: [buildCchookHookEntry()],
  },
});

function symlinked(content: string): { path: string; real: string; backupDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'xcg-managed-'));
  tmpDirs.push(root);
  const real = join(root, 'dotfiles', 'settings.json');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, content);
  const path = join(root, '.claude', 'settings.json');
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(real, path);
  return { path, real, backupDir: join(root, 'backups') };
}

describe('Install on a symlinked settings.json', () => {
  it('writes nothing; returns reason, resolved target and the snippet for the detected version', () => {
    const { path, real, backupDir } = symlinked(JSON.stringify({ model: 'x', hooks: { Stop: [FOREIGN] } }));
    const res = installCchook(path, cchookEventsFor('2.1.50'), { backupDir });
    expect(res.ok).toBe(false);
    const managed = (res as { managed?: { reason: string; target?: string; snippet: string } }).managed!;
    expect(managed.reason).toBe('symlink');
    expect(managed.target).toBe(realpathSync(real));
    const snippet = JSON.parse(managed.snippet) as { hooks: Record<string, unknown> };
    expect(Object.keys(snippet)).toEqual(['hooks']);
    expect(Object.keys(snippet.hooks)).toEqual(['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd']);
    expect(managed.snippet).not.toContain('echo user-hook');
    expect(readFileSync(real, 'utf8')).toBe(JSON.stringify({ model: 'x', hooks: { Stop: [FOREIGN] } }));
  });
});

describe('Update on a symlinked settings.json', () => {
  it('writes nothing; the snippet holds only the missing entries', () => {
    const { path, real, backupDir } = symlinked(OLD_INSTALL);
    const res = updateCchook({ settingsPath: path, backupDir, events: cchookEventsFor('2.1.284') });
    const managed = (res as { managed?: { snippet: string } }).managed!;
    expect(JSON.parse(managed.snippet)).toEqual({
      hooks: {
        Elicitation: [buildCchookHookEntry('Elicitation')],
        ElicitationResult: [buildCchookHookEntry('ElicitationResult')],
      },
    });
    expect(readFileSync(real, 'utf8')).toBe(OLD_INSTALL);
  });
});

describe('not a regular file / another owner', () => {
  it('a directory named settings.json → not_regular, no target', () => {
    const root = mkdtempSync(join(tmpdir(), 'xcg-managed-'));
    tmpDirs.push(root);
    const path = join(root, '.claude', 'settings.json');
    mkdirSync(path, { recursive: true });
    const res = installCchook(path, cchookEventsFor('2.1.284'), { backupDir: join(root, 'b') });
    const managed = (res as { managed?: { reason: string; target?: string } }).managed!;
    expect(managed.reason).toBe('not_regular');
    expect(managed.target).toBeUndefined();
  });

  it('owned by another user → foreign_owner, no target', () => {
    const root = mkdtempSync(join(tmpdir(), 'xcg-managed-'));
    tmpDirs.push(root);
    const path = join(root, 'settings.json');
    writeFileSync(path, '{}');
    const read = readSettingsGuarded(path, (process.getuid?.() ?? 501) + 1);
    expect(read).toMatchObject({ ok: false, kind: 'managed', reason: 'foreign_owner' });
    expect('target' in read).toBe(false);
  });
});

describe('managedSettingsStatus (cchook:status)', () => {
  it('a regular file → null; a symlink → the update snippet', () => {
    const root = mkdtempSync(join(tmpdir(), 'xcg-managed-'));
    tmpDirs.push(root);
    const regular = join(root, 'settings.json');
    writeFileSync(regular, OLD_INSTALL);
    expect(managedSettingsStatus(regular, cchookEventsFor('2.1.284'))).toBeNull();
    const { path } = symlinked(OLD_INSTALL);
    const status = managedSettingsStatus(path, cchookEventsFor('2.1.284'))!;
    expect(status.reason).toBe('symlink');
    expect(Object.keys((JSON.parse(status.snippet) as { hooks: object }).hooks)).toEqual(['Elicitation', 'ElicitationResult']);
  });
});
