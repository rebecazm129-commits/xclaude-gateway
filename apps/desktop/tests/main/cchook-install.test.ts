// Tests for installCchook/uninstallCchook (cchook-install.ts) over temp
// settings paths — the real ~/.claude is never touched. The invariant under
// test everywhere: unparseable settings are NEVER overwritten.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CCHOOK_MARKER, mergeCchookHooks } from '@xcg/shared/config';
import { installCchook, uninstallCchook } from '../../src/main/cchook-install.js';

const tmpDirs: string[] = [];
function tempSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-cchook-install-'));
  tmpDirs.push(dir);
  // A NOT-yet-existing nested path: proves the seed's mkdir.
  return join(dir, '.claude', 'settings.json');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The copies go next to the temp settings, never to the real backups folder.
const tmpBackups = (settingsPath: string): { backupDir: string } => ({
  backupDir: join(dirname(dirname(settingsPath)), 'xcg-backups'),
});

const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

// Pre-existing settings fixture: creates the .claude parent first (only the
// install seed path does that in production; these tests simulate a file that
// was already there).
function preWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

describe('installCchook', () => {
  it('file absent → created (mkdir + our hooks), 0600, no .bak and no copy (nothing to copy)', () => {
    const path = tempSettingsPath();
    const res = installCchook(path, undefined, tmpBackups(path));
    expect(res).toEqual({ ok: true, outcome: 'wrote', settingsPath: path });
    const hooks = read(path)['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(hooks['PostToolUse'])).toContain(CCHOOK_MARKER);
    // The guarded write keeps no .bak next to settings.json, and an absent
    // file has no bytes to copy into the backups folder.
    expect(existsSync(`${path}.bak`)).toBe(false);
    expect(existsSync(tmpBackups(path).backupDir)).toBe(false);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('prior manual registration → noop, disk untouched', () => {
    const path = tempSettingsPath();
    const manual = JSON.stringify(mergeCchookHooks({ theme: 'dark' }).settings);
    preWrite(path, manual);
    const before = readFileSync(path, 'utf8');

    const res = installCchook(path, undefined, tmpBackups(path));
    expect(res).toEqual({ ok: true, outcome: 'noop', settingsPath: path });
    expect(readFileSync(path, 'utf8')).toBe(before); // byte-identical
    expect(existsSync(`${path}.bak`)).toBe(false); // no write → no backup
  });

  it('corrupt JSON → readable error, disk intact, nothing written', () => {
    const path = tempSettingsPath();
    preWrite(path, '{"hooks": BROKEN');
    const res = installCchook(path, undefined, tmpBackups(path));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not valid JSON');
    expect(readFileSync(path, 'utf8')).toBe('{"hooks": BROKEN');
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('preserves foreign hooks and fields through a real install', () => {
    const path = tempSettingsPath();
    const foreign = {
      model: 'claude-fable-5',
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    preWrite(path, JSON.stringify(foreign));
    expect(installCchook(path, undefined, tmpBackups(path))).toMatchObject({ ok: true, outcome: 'wrote' });
    const after = read(path);
    expect(after['model']).toBe('claude-fable-5');
    const post = (after['hooks'] as Record<string, unknown[]>)['PostToolUse']!;
    expect(post).toHaveLength(2);
    expect(JSON.stringify(post[0])).not.toContain(CCHOOK_MARKER);
  });
});

describe('uninstallCchook', () => {
  it('file absent → ok noop', () => {
    const path = tempSettingsPath();
    expect(uninstallCchook(path, tmpBackups(path))).toEqual({ ok: true, outcome: 'noop', settingsPath: path });
    expect(existsSync(path)).toBe(false); // nothing created either
  });

  it('installed state → surgically removed, foreign preserved; second run noop', () => {
    const path = tempSettingsPath();
    const foreign = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    preWrite(path, JSON.stringify(foreign));
    installCchook(path, undefined, tmpBackups(path));

    const res = uninstallCchook(path, tmpBackups(path));
    expect(res).toMatchObject({ ok: true, outcome: 'wrote' });
    const after = read(path);
    expect(JSON.stringify(after)).not.toContain(CCHOOK_MARKER);
    expect((after['hooks'] as Record<string, unknown[]>)['PostToolUse']).toHaveLength(1);

    expect(uninstallCchook(path, tmpBackups(path))).toMatchObject({ ok: true, outcome: 'noop' });
  });

  it('corrupt JSON → error, disk intact', () => {
    const path = tempSettingsPath();
    preWrite(path, `not json ${CCHOOK_MARKER}`);
    const res = uninstallCchook(path, tmpBackups(path));
    expect(res.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(`not json ${CCHOOK_MARKER}`);
  });
});
