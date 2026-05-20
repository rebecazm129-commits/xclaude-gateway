import { existsSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSymlink, removeSymlink } from '../../src/config/install.js';

describe('ensureSymlink — idempotent symlink ensure (Milestone 4 Phase 3a)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-install-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Build a fake "target" — a regular file inside the tmp dir. The symlink
  // points at it. Tests never touch ~/Library; everything lives in tmp.
  function makeTarget(name = 'fake-launcher'): string {
    const p = join(tmp, name);
    writeFileSync(p, '#!/bin/sh\necho fake\n');
    return p;
  }

  it('(i) absent linkPath: creates parent dir + symlink, status=created', () => {
    const target = makeTarget();
    const link = join(tmp, 'sub', 'nested', 'xcg-proxy');
    const r = ensureSymlink(target, link);
    expect(r).toEqual({ ok: true, status: 'created' });
    expect(existsSync(link)).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it('(ii) linkPath is a symlink to targetPath: no-op, status=already', () => {
    const target = makeTarget();
    const link = join(tmp, 'xcg-proxy');
    symlinkSync(target, link);
    const r = ensureSymlink(target, link);
    expect(r).toEqual({ ok: true, status: 'already' });
    expect(readlinkSync(link)).toBe(target);
  });

  it('(iii) linkPath is a symlink to a different target: re-points, status=updated', () => {
    const oldTarget = makeTarget('old-launcher');
    const newTarget = makeTarget('new-launcher');
    const link = join(tmp, 'xcg-proxy');
    symlinkSync(oldTarget, link);
    const r = ensureSymlink(newTarget, link);
    expect(r).toEqual({ ok: true, status: 'updated' });
    expect(readlinkSync(link)).toBe(newTarget);
  });

  it('(iv) linkPath is a regular file: refuses to clobber, error=not-a-symlink', () => {
    const target = makeTarget();
    const link = join(tmp, 'xcg-proxy');
    writeFileSync(link, 'i am a regular file, do not delete me');
    const r = ensureSymlink(target, link);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not-a-symlink');
    // The file is still there, untouched.
    expect(existsSync(link)).toBe(true);
  });

  it('recreation: after removeSymlink, ensureSymlink works again (created)', () => {
    const target = makeTarget();
    const link = join(tmp, 'xcg-proxy');
    expect(ensureSymlink(target, link).ok).toBe(true);
    expect(removeSymlink(link).ok).toBe(true);
    const r = ensureSymlink(target, link);
    expect(r).toEqual({ ok: true, status: 'created' });
  });

  it('idempotent: calling ensureSymlink twice with the same args is stable', () => {
    const target = makeTarget();
    const link = join(tmp, 'xcg-proxy');
    expect(ensureSymlink(target, link)).toEqual({ ok: true, status: 'created' });
    expect(ensureSymlink(target, link)).toEqual({ ok: true, status: 'already' });
    expect(readlinkSync(link)).toBe(target);
  });

  it('points at a non-existent target without error: symlinks may dangle', () => {
    // POSIX symlinks need not point at existing files; ensureSymlink should
    // not validate the target. F3b/F4 may want to verify separately, but
    // that is not this function's job.
    const target = join(tmp, 'does-not-exist-yet');
    const link = join(tmp, 'xcg-proxy');
    const r = ensureSymlink(target, link);
    expect(r).toEqual({ ok: true, status: 'created' });
    expect(readlinkSync(link)).toBe(target);
  });
});

describe('removeSymlink — idempotent uninstall', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-install-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('removes an existing symlink, status=removed', () => {
    const target = join(tmp, 'fake');
    writeFileSync(target, 'x');
    const link = join(tmp, 'xcg-proxy');
    symlinkSync(target, link);
    const r = removeSymlink(link);
    expect(r).toEqual({ ok: true, status: 'removed' });
    expect(existsSync(link)).toBe(false);
    // Target untouched.
    expect(existsSync(target)).toBe(true);
  });

  it('absent linkPath: no-op, status=absent', () => {
    const link = join(tmp, 'never-existed');
    const r = removeSymlink(link);
    expect(r).toEqual({ ok: true, status: 'absent' });
  });

  it('linkPath is a regular file: refuses to clobber, error=not-a-symlink', () => {
    const link = join(tmp, 'real-file');
    writeFileSync(link, 'do not delete me');
    const r = removeSymlink(link);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not-a-symlink');
    expect(existsSync(link)).toBe(true);
  });

  it('idempotent: calling removeSymlink twice is stable', () => {
    const target = join(tmp, 'fake');
    writeFileSync(target, 'x');
    const link = join(tmp, 'xcg-proxy');
    symlinkSync(target, link);
    expect(removeSymlink(link)).toEqual({ ok: true, status: 'removed' });
    expect(removeSymlink(link)).toEqual({ ok: true, status: 'absent' });
  });
});
