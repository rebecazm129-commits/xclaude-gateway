// Symlink installer — idempotent ensure/remove of a stable symlink
// (Milestone 4 Phase 3). Pure w.r.t. the filesystem except for the
// specific syscalls needed; never throws. Errors surface as a typed
// EnsureResult/RemoveResult discriminated union. Knows nothing about
// xCLAUDE-specific paths: the caller passes target and link absolute
// paths. F3b (Electron main bootstrap) and F4 (xcg-config CLI) compose
// this with the install-specific paths.

import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// --- Result types ---

export type EnsureResult =
  | { ok: true; status: 'created' | 'already' | 'updated' }
  | { ok: false; error: InstallError };

export type RemoveResult =
  | { ok: true; status: 'removed' | 'absent' }
  | { ok: false; error: InstallError };

export type InstallError =
  | { kind: 'not-a-symlink'; detail: string }  // linkPath exists and is NOT a symlink (refuse to clobber)
  | { kind: 'permission'; detail: string }
  | { kind: 'io'; detail: string };

// --- Internal helpers ---

function classifyFsError(e: unknown): InstallError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'permission', detail: code };
  }
  return { kind: 'io', detail: code ?? String(e) };
}

// --- Public surface ---

// Ensure linkPath is a symlink pointing at targetPath. Idempotent:
//   (i)   linkPath absent → mkdir parent + symlink, returns 'created'.
//   (ii)  linkPath is a symlink to targetPath → no-op, returns 'already'.
//   (iii) linkPath is a symlink to something else → unlink + symlink, returns 'updated'.
//   (iv)  linkPath exists but is NOT a symlink → error 'not-a-symlink'
//         (refuse to clobber a regular file; that would be destructive).
export function ensureSymlink(targetPath: string, linkPath: string): EnsureResult {
  // Step 1: probe linkPath without following symlinks.
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Case (i): create parent dir + symlink.
      try {
        mkdirSync(dirname(linkPath), { recursive: true, mode: 0o700 });
        symlinkSync(targetPath, linkPath);
        return { ok: true, status: 'created' };
      } catch (e2) {
        return { ok: false, error: classifyFsError(e2) };
      }
    }
    return { ok: false, error: classifyFsError(e) };
  }

  // Step 2: linkPath exists. Check whether it is a symlink.
  if (!stat.isSymbolicLink()) {
    return {
      ok: false,
      error: { kind: 'not-a-symlink', detail: 'linkPath exists and is not a symlink' },
    };
  }

  // Step 3: it is a symlink. Read its target and compare.
  let current: string;
  try {
    current = readlinkSync(linkPath);
  } catch (e) {
    return { ok: false, error: classifyFsError(e) };
  }
  if (current === targetPath) {
    return { ok: true, status: 'already' };
  }

  // Step 4: re-point.
  try {
    unlinkSync(linkPath);
    symlinkSync(targetPath, linkPath);
    return { ok: true, status: 'updated' };
  } catch (e) {
    return { ok: false, error: classifyFsError(e) };
  }
}

// Remove linkPath iff it is a symlink. Absent → no-op (idempotent uninstall).
// If linkPath exists and is NOT a symlink, refuse and report — same safety
// rule as ensureSymlink: never clobber a regular file we did not create.
export function removeSymlink(linkPath: string): RemoveResult {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: true, status: 'absent' };
    }
    return { ok: false, error: classifyFsError(e) };
  }
  if (!stat.isSymbolicLink()) {
    return {
      ok: false,
      error: { kind: 'not-a-symlink', detail: 'linkPath exists and is not a symlink' },
    };
  }
  try {
    unlinkSync(linkPath);
    return { ok: true, status: 'removed' };
  } catch (e) {
    return { ok: false, error: classifyFsError(e) };
  }
}
