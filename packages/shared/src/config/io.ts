// Atomic IO helpers for the xcg-config domain (Milestone 4 Phase 5.1 sub-step C1).
// Extracted from packages/proxy/src/config/cli.ts so both the CLI (xcg-config
// install/uninstall) and the apps/desktop main IPC handlers (F5.1 sub-step C2)
// share the same write path with the same .bak first-write-wins semantics and
// the same fsync-rename-fsync atomicity guarantee.
//
// Result-typed, never throws — consistent with ensureSymlink/removeSymlink in
// ./install.ts. Consumers can map WriteAtomicError to their own error shapes
// (CLI: schema:1 JSON; IPC: IpcConfigError) without try/catch.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type WriteAtomicError =
  | { kind: 'permission'; detail: string }
  | { kind: 'io'; detail: string };

export type WriteAtomicResult =
  | { ok: true }
  | { ok: false; error: WriteAtomicError };

// Atomic write: tmpfile in same dir, fsync tmp, rename to target, fsync dir.
// Preserves the original file's permissions. .bak is created first-write-wins:
// only if it doesn't exist already (it represents the user's pre-xCLAUDE
// state, captured once and preserved across reinstalls).
//
// The directory fsync is paranoia justified by the Hito 4 risk: a kernel
// panic between the rename and the dirent sync would otherwise leave the
// user with no config.
export function writeAtomic(
  configPath: string,
  newContent: unknown,
): WriteAtomicResult {
  try {
    const dir = dirname(configPath);
    const bakPath = `${configPath}.bak`;

    // First-write-wins backup. If a previous install already wrote .bak,
    // leave it untouched.
    if (!existsSync(bakPath)) {
      copyFileSync(configPath, bakPath);
      const bakFd = openSync(bakPath, 'r');
      fsyncSync(bakFd);
      closeSync(bakFd);
    }

    // Inherit permissions from the existing config.
    const origMode = statSync(configPath).mode & 0o777;

    // Write new content to tmpfile in same dir.
    const tmpPath = join(dir, `${basename(configPath)}.tmp.${process.pid}`);
    const serialized = `${JSON.stringify(newContent, null, 2)}\n`;
    writeFileSync(tmpPath, serialized, { mode: origMode });

    // fsync the tmpfile.
    const tmpFd = openSync(tmpPath, 'r');
    fsyncSync(tmpFd);
    closeSync(tmpFd);

    // Atomic rename.
    renameSync(tmpPath, configPath);

    // fsync the directory so the rename hits disk.
    const dirFd = openSync(dir, 'r');
    fsyncSync(dirFd);
    closeSync(dirFd);

    return { ok: true };
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { ok: false, error: { kind: 'permission', detail } };
    }
    return { ok: false, error: { kind: 'io', detail } };
  }
}
