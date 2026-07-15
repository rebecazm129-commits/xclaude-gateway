// Unit tests for the cross-process refresh lock (refresh-lock.ts). Real
// filesystem semantics on purpose: O_EXCL, rename-reclaim and mtime staleness
// are exactly what production relies on, so they run against a temp dir.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { acquireRefreshLock, refreshLockPath } from '../src/refresh-lock.js';

const tmpDirs: string[] = [];
function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-refresh-lock-'));
  tmpDirs.push(dir);
  return join(dir, 'locks', 'notion.refresh.lock');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('acquireRefreshLock', () => {
  it('acquires a free lock, writes our PID, and release() removes the file', async () => {
    const lockPath = tempLockPath();
    const result = await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 });
    expect(result.acquired).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    if (result.acquired) await result.release();
    expect(existsSync(lockPath)).toBe(false);
    // Re-acquire after release works (no residue).
    const again = await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 });
    expect(again.acquired).toBe(true);
    if (again.acquired) await again.release();
  });

  it('(b) reclaims an orphaned lock (owner PID dead) and continues', async () => {
    const lockPath = tempLockPath();
    // Pre-create an orphan: plausible PID, owner reported dead by the probe.
    await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200, pid: 54321 });
    expect(readFileSync(lockPath, 'utf8')).toBe('54321');

    const result = await acquireRefreshLock(lockPath, {
      pollMs: 5,
      timeoutMs: 500,
      isPidAlive: (pid) => pid !== 54321,
    });
    expect(result.acquired).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    if (result.acquired) await result.release();
  });

  it('reclaims via the mtime hard cap even when the owner PID looks alive', async () => {
    const lockPath = tempLockPath();
    // Owner = ourselves (definitely alive), but the lock is ancient: PID-reuse /
    // stalled-owner cover.
    await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 });
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old);

    const result = await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 500, staleMs: 30_000 });
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();
  });

  it('times out fail-open when the lock is young and its owner is alive', async () => {
    const lockPath = tempLockPath();
    await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 }); // held by us, never released

    const result = await acquireRefreshLock(lockPath, { pollMs: 10, timeoutMs: 60 });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.waitedMs).toBeGreaterThanOrEqual(60);
    // The holder's lock is untouched.
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('release() does not unlink a lock that was reclaimed by someone else', async () => {
    const lockPath = tempLockPath();
    const mine = await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 });
    expect(mine.acquired).toBe(true);
    // Simulate a contender that reclaimed us (mtime cap) and now owns the path.
    writeFileSync(lockPath, '99999', { mode: 0o600 });
    if (mine.acquired) await mine.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('99999');
  });
});

describe('refreshLockPath', () => {
  it('is per-connector under baseDir/locks', () => {
    const p = refreshLockPath('notion');
    expect(p.endsWith(join('xCLAUDE Gateway', 'locks', 'notion.refresh.lock'))).toBe(true);
    expect(refreshLockPath('slack')).not.toBe(p);
  });
});
