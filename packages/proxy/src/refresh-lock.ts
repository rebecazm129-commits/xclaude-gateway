// Cross-process lock for the OAuth refresh single-flight (design approved after
// the notion grant-revocation incident: Claude Desktop keeps two full wrapper
// generations alive, and two processes refreshing the same rotating RT trip the
// server's reuse detection). O_EXCL lockfile with the owner PID inside, double
// staleness (dead PID via ESRCH, plus an mtime hard cap that covers PID reuse
// and crashed-mid-write owners), and atomic-rename reclaim so exactly one
// contender wins a stale lock.
//
// Semantics are advisory and FAIL-OPEN by design: a caller that cannot acquire
// within timeoutMs proceeds without the lock — the worst case is today's
// behavior (a possible reuse revocation), never a dead connector.

import { mkdirSync } from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Poll cadence while another process holds the lock. */
export const LOCK_POLL_MS = 150;

/** Give-up threshold: past this, the caller proceeds WITHOUT the lock (fail-open). */
export const LOCK_TIMEOUT_MS = 15_000;

/**
 * Mtime hard cap: a lock older than this is reclaimed even if its PID looks
 * alive. Covers PID reuse (kill(pid, 0) succeeding for an unrelated process)
 * and owners that died between open('wx') and writing their PID. Far above any
 * plausible token-endpoint round trip.
 */
export const LOCK_STALE_MS = 30_000;

export interface RefreshLockOptions {
  pollMs?: number;
  timeoutMs?: number;
  staleMs?: number;
  /** Owner PID written into the lock. Injectable for tests; defaults to process.pid. */
  pid?: number;
  /** Liveness probe. Injectable for tests; defaults to kill(pid, 0) / ESRCH. */
  isPidAlive?: (pid: number) => boolean;
}

export type RefreshLockResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; waitedMs: number };

/** Canonical lock location: baseDir/locks/<mcp>.refresh.lock, shared by every
 *  process of the same connector (wrappers of any generation + the login flow). */
export function refreshLockPath(mcp: string): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'xCLAUDE Gateway',
    'locks',
    `${mcp}.refresh.lock`,
  );
}

// Same-user processes, so EPERM ambiguity doesn't apply here; still, only ESRCH
// means "definitely dead" — anything else counts as alive (conservative: an
// alive verdict just means we keep waiting until the mtime hard cap).
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function acquireRefreshLock(
  lockPath: string,
  opts: RefreshLockOptions = {},
): Promise<RefreshLockResult> {
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let reclaimSeq = 0;

  for (;;) {
    try {
      const fd = await open(lockPath, 'wx', 0o600);
      try {
        await fd.writeFile(String(pid), 'utf8');
      } finally {
        await fd.close();
      }
      return { acquired: true, release: () => releaseLock(lockPath, pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (await isStale(lockPath, staleMs, isPidAlive)) {
      // Atomic-rename reclaim: rename() succeeds for exactly one contender; the
      // loser gets ENOENT and simply retries the O_EXCL open. Never unlink the
      // live path directly — two unlinkers could each "free" a lock the other
      // already re-created.
      const graveyard = `${lockPath}.reclaimed.${pid}.${reclaimSeq++}`;
      try {
        await rename(lockPath, graveyard);
        await unlink(graveyard).catch(() => undefined);
      } catch {
        // Lost the reclaim race — the winner's fresh lock is now in place.
      }
      continue; // retry the open immediately, no poll delay
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) return { acquired: false, waitedMs };
    await sleep(pollMs);
  }
}

async function isStale(
  lockPath: string,
  staleMs: number,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  let mtimeMs: number;
  let content: string;
  try {
    const st = await stat(lockPath);
    mtimeMs = st.mtimeMs;
    content = await readFile(lockPath, 'utf8');
  } catch {
    // Vanished between our failed open and this check (owner released or a
    // reclaim won): not stale — the caller loops and retries the open.
    return false;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  const ownerPid = Number.parseInt(content, 10);
  if (Number.isInteger(ownerPid) && ownerPid > 0) return !isPidAlive(ownerPid);
  // Empty or garbled but young: the owner may be between open('wx') and
  // writeFile. Wait; the mtime cap bounds how long this can stall us.
  return false;
}

async function releaseLock(lockPath: string, pid: number): Promise<void> {
  // Unlink only if the lock is still ours: if a contender reclaimed us via the
  // mtime hard cap while we were alive-but-stalled, lockPath now belongs to it.
  try {
    const content = await readFile(lockPath, 'utf8');
    if (Number.parseInt(content, 10) !== pid) return;
    await unlink(lockPath);
  } catch {
    // Already gone — nothing to release.
  }
}
