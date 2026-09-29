// Install and Uninstall through the guarded write (claude-settings-write.ts):
// same rules as Update — a settings file managed externally is never written,
// the change aborts if the file moves underneath, and the exact bytes are
// copied to our backups folder first (no copy, no write). Temp paths only.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CCHOOK_MARKER, mergeCchookHooks } from '@xcg/shared/config';
import { installCchook, uninstallCchook } from '../../src/main/cchook-install.js';
import { CHANGED_DURING_UPDATE, MANAGED_EXTERNALLY } from '../../src/main/claude-settings-write.js';

const tmpDirs: string[] = [];
function setup(content?: string): { path: string; backupDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'xcg-cchook-guarded-'));
  tmpDirs.push(root);
  const path = join(root, '.claude', 'settings.json');
  if (content !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }
  return { path, backupDir: join(root, 'backups'), root };
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const FOREIGN = JSON.stringify({ model: 'claude-fable-5', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] } });
const INSTALLED = JSON.stringify(mergeCchookHooks(JSON.parse(FOREIGN)).settings, null, 2);

describe('Install (guarded)', () => {
  it('over an existing file: the exact bytes are copied first, then the hook is added', () => {
    const { path, backupDir } = setup(FOREIGN);
    const res = installCchook(path, undefined, { backupDir });
    expect(res).toMatchObject({ ok: true, outcome: 'wrote' });
    const copy = (res as { backupPath: string }).backupPath;
    expect(readFileSync(copy, 'utf8')).toBe(FOREIGN);
    expect(readFileSync(path, 'utf8')).toContain(CCHOOK_MARKER);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('absent file: created 0600, no copy (nothing to copy)', () => {
    const { path, backupDir } = setup();
    expect(installCchook(path, undefined, { backupDir })).toEqual({ ok: true, outcome: 'wrote', settingsPath: path });
    expect(readFileSync(path, 'utf8')).toContain(CCHOOK_MARKER);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('a symlinked settings.json is managed externally: not written, not followed', () => {
    const { path, backupDir, root } = setup();
    const real = join(root, 'dotfiles.json');
    writeFileSync(real, FOREIGN);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(real, path);
    expect(installCchook(path, undefined, { backupDir })).toMatchObject({ ok: false, error: MANAGED_EXTERNALLY, managed: { reason: 'symlink' } });
    expect(readFileSync(real, 'utf8')).toBe(FOREIGN);
  });

  it('a change while installing aborts; the concurrent content survives', () => {
    const { path, backupDir } = setup(FOREIGN);
    const res = installCchook(path, undefined, { backupDir, swapHooks: { beforeCompare: () => writeFileSync(path, '{"x":1}') } });
    expect(res).toEqual({ ok: false, error: CHANGED_DURING_UPDATE });
    expect(readFileSync(path, 'utf8')).toBe('{"x":1}');
  });

  it('if the copy fails, nothing is installed', () => {
    const { path, root } = setup(FOREIGN);
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const res = installCchook(path, undefined, { backupDir: join(blocker, 'sub') });
    expect(res.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(FOREIGN);
  });
});

describe('Uninstall (guarded)', () => {
  it('copies the exact bytes first, removes only our entries', () => {
    const { path, backupDir } = setup(INSTALLED);
    const res = uninstallCchook(path, { backupDir });
    expect(res).toMatchObject({ ok: true, outcome: 'wrote' });
    expect(readFileSync((res as { backupPath: string }).backupPath, 'utf8')).toBe(INSTALLED);
    expect(readFileSync(path, 'utf8')).not.toContain(CCHOOK_MARKER);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(FOREIGN));
  });

  it('a symlinked settings.json is managed externally: not written', () => {
    const { path, backupDir, root } = setup();
    const real = join(root, 'dotfiles.json');
    writeFileSync(real, INSTALLED);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(real, path);
    expect(uninstallCchook(path, { backupDir })).toEqual({ ok: false, error: MANAGED_EXTERNALLY });
    expect(readFileSync(real, 'utf8')).toBe(INSTALLED);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('a change while uninstalling aborts', () => {
    const { path, backupDir } = setup(INSTALLED);
    const res = uninstallCchook(path, { backupDir, swapHooks: { beforeCompare: () => writeFileSync(path, '{"y":2}') } });
    expect(res).toEqual({ ok: false, error: CHANGED_DURING_UPDATE });
    expect(readFileSync(path, 'utf8')).toBe('{"y":2}');
    expect(readdirSync(dirname(path)).filter((f) => f.includes('xcg-tmp'))).toEqual([]);
  });
});
