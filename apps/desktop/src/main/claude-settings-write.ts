// Guarded write of Claude Code's ~/.claude/settings.json for the hook Install,
// Update and Uninstall (cchook-install.ts). The file belongs to the user and to Claude
// Code; xCLAUDE only ever touches its own hook entries, and before it writes:
//
//   1. It refuses a file it does not plainly own: a symlink, anything that is
//      not a regular file, or a file owned by another user is treated as
//      managed externally (dotfile managers, MDM) and left alone.
//   2. It keeps the exact bytes it read and their hash, and copies those bytes
//      to backups/claude-settings/ (dir 0700, files 0600, the newest 3 kept).
//      If the copy fails, nothing is written.
//   3. Compare-before-swap: the new content goes to a temp file in the same
//      directory; right before the rename the target is read again and its
//      hash compared with the one read at the start. Changed → abort, temp
//      removed, the user's file untouched. (This narrows the window to the
//      compare→rename gap; it cannot close it — no file lock is shared with
//      Claude Code.)
//
// The caller re-reads and verifies the result afterwards.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { xcgDataDir } from '@xcg/shared/config';

export const MANAGED_EXTERNALLY =
  "Claude Code settings appear to be managed externally. xCLAUDE won't update this file automatically.";
export const CHANGED_DURING_UPDATE = 'Claude Code settings changed while xCLAUDE was updating them. Try again.';

/** Copies kept of the settings file, newest first. */
export const SETTINGS_BACKUPS_KEPT = 3;

/** A path inside the home directory, shown as ~/… (display only). */
export function tildify(path: string, home: string = homedir()): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function defaultSettingsBackupDir(home: string = homedir()): string {
  return join(xcgDataDir(home), 'backups', 'claude-settings');
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Why a settings file is treated as managed externally. */
export type ManagedReason = 'symlink' | 'not_regular' | 'foreign_owner';

export type GuardedRead =
  | { ok: true; bytes: Buffer; hash: string; mode: number; settings: unknown }
  | { ok: false; kind: 'managed'; error: string; reason: ManagedReason; /** symlink: where it resolves */ target?: string }
  | { ok: false; kind: 'absent' | 'invalid' | 'io'; error: string };

// Where a symlink ends up, for the user to see — never used to write.
function resolvedTarget(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  }
}

const managed = (reason: ManagedReason, target?: string): GuardedRead => ({
  ok: false,
  kind: 'managed',
  error: MANAGED_EXTERNALLY,
  reason,
  // Display only (the notice's "→ <target>" line): home shown as ~.
  ...(target !== undefined ? { target: tildify(target) } : {}),
});

/** Reads the settings file only if it is a regular file of the current user
 *  (lstat, then O_NOFOLLOW + fstat on the same inode). */
export function readSettingsGuarded(path: string, uid: number | undefined = process.getuid?.()): GuardedRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, kind: 'absent', error: `${path} does not exist.` };
    return { ok: false, kind: 'io', error: `cannot read ${path}: ${(err as Error).message}` };
  }
  if (st.isSymbolicLink()) return managed('symlink', resolvedTarget(path));
  if (!st.isFile()) return managed('not_regular');
  if (uid !== undefined && st.uid !== uid) return managed('foreign_owner');
  let bytes: Buffer;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) return managed('not_regular');
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return managed('symlink', resolvedTarget(path));
    return { ok: false, kind: 'io', error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const text = bytes.toString('utf8');
  let settings: unknown = {};
  if (text.trim() !== '') {
    try {
      settings = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, kind: 'invalid', error: `${path} is not valid JSON — fix or remove it and retry. Nothing was written.` };
    }
  }
  return { ok: true, bytes, hash: sha256(bytes), mode: st.mode & 0o777, settings };
}

const BACKUP_RE = /^settings-\d{8}T\d{9}Z(?:-\d+)?\.json$/;

/** Copies `bytes` into `dir` (0700) as a new 0600 file, then keeps only the
 *  newest SETTINGS_BACKUPS_KEPT copies. Never overwrites an existing copy. */
export function backupSettings(
  bytes: Buffer,
  dir: string = defaultSettingsBackupDir(),
  now: Date = new Date(),
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dst = lstatSync(dir);
    if (dst.isSymbolicLink() || !dst.isDirectory()) throw new Error(`${dir} is not a directory`);
    chmodSync(dir, 0o700);
    const stamp = now.toISOString().replace(/[-:.]/g, '');
    let path = '';
    let fd = -1;
    for (let n = 0; n < 10 && fd === -1; n++) {
      path = join(dir, `settings-${stamp}${n === 0 ? '' : `-${n}`}.json`);
      try {
        fd = openSync(path, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    if (fd === -1) throw new Error('no free backup name');
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const copies = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - SETTINGS_BACKUPS_KEPT))) {
      unlinkSync(join(dir, old));
    }
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: `could not back up Claude Code settings (${(err as Error).message}). Nothing was changed.` };
  }
}

export interface SwapHooks {
  /** Test seam: runs after the temp file is written, before the re-read. */
  beforeCompare?: () => void;
}

/** Writes `content` over `path` only if the file still hashes to
 *  `expectedHash` right before the rename. */
export function swapSettingsIfUnchanged(
  path: string,
  expectedHash: string,
  content: unknown,
  mode: number,
  hooks: SwapHooks = {},
): { ok: true } | { ok: false; kind: 'changed' | 'managed' | 'io'; error: string } {
  const dir = dirname(path);
  const tmp = join(dir, `${basename(path)}.xcg-tmp.${process.pid}`);
  let tmpWritten = false;
  try {
    const fd = openSync(tmp, 'wx', mode);
    tmpWritten = true;
    try {
      writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    hooks.beforeCompare?.();
    const again = readSettingsGuarded(path);
    if (!again.ok) {
      unlinkSync(tmp);
      return again.kind === 'managed'
        ? { ok: false, kind: 'managed', error: MANAGED_EXTERNALLY }
        : { ok: false, kind: 'changed', error: CHANGED_DURING_UPDATE };
    }
    if (again.hash !== expectedHash) {
      unlinkSync(tmp);
      return { ok: false, kind: 'changed', error: CHANGED_DURING_UPDATE };
    }
    renameSync(tmp, path);
    tmpWritten = false;
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return { ok: true };
  } catch (err) {
    if (tmpWritten) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort — the original error is what matters
      }
    }
    return { ok: false, kind: 'io', error: `write failed: ${(err as Error).message}` };
  }
}

/** Creates `path` with `content` only if it still does not exist (the tmp is
 *  hard-linked into place: link fails if something appeared meanwhile).
 *  Parent directories are created; the file is 0600. */
export function createSettingsIfAbsent(
  path: string,
  content: unknown,
): { ok: true } | { ok: false; kind: 'changed' | 'io'; error: string } {
  const dir = dirname(path);
  const tmp = join(dir, `${basename(path)}.xcg-tmp.${process.pid}`);
  let tmpWritten = false;
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, 'wx', 0o600);
    tmpWritten = true;
    try {
      writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, kind: 'changed', error: CHANGED_DURING_UPDATE };
      }
      throw err;
    }
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: 'io', error: `cannot create ${path}: ${(err as Error).message}` };
  } finally {
    if (tmpWritten) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }
}
