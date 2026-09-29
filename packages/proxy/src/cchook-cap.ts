// The spool's cap. While the desktop app is closed nothing drains
// claude-code/spool/, and every Claude Code tool call adds a file. Before
// writing, xcg-cchook checks two limits and, past either, writes nothing:
//
//   - free space on the spool's disk below SPOOL_MIN_FREE_BYTES (statfsSync:
//     ~1 ms), so a long absence can never fill the disk;
//   - more than SPOOL_MAX_FILES files in the spool (a bare readdirSync, no
//     stat per file: ~34 ms at 50,000 files on an M-series Mac, well under a
//     millisecond at normal sizes).
//
// A dropped event is COUNTED, never lost silently: one byte is appended to
// claude-code/spool-dropped with O_APPEND. Appends of that size to a local
// file are atomic, so concurrent hooks each add exactly one byte with no lock
// and no read-modify-write; the count is the file's size, and the file's own
// birth and modification times bound when the drops happened. The ingester
// takes the file by renaming it (cchook-dropped.ts in the desktop app).
//
// If a check itself fails (statfs unavailable, unreadable dir), the hook
// writes as before: the cap must never become a reason to lose captures.
//
// Dependencies: node:fs and node:path only — this runs inside the hook (and a
// test imports it from a bare child process).

import { appendFileSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Below this much free space on the spool's disk, nothing is written. */
export const SPOOL_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
/** Past this many files in the spool, nothing is written. */
export const SPOOL_MAX_FILES = 50_000;
/** The drop counter, next to the spool dir (claude-code/spool-dropped). */
export const SPOOL_DROPPED_FILENAME = 'spool-dropped';

export interface SpoolLimits {
  minFreeBytes?: number;
  maxFiles?: number;
}

export interface SpoolCapDeps {
  /** Free bytes on the disk holding `path`; default statfsSync. */
  freeBytes?: (path: string) => number;
  /** Entry count of `dir`; default readdirSync(dir).length. */
  countFiles?: (dir: string) => number;
}

function statfsFree(path: string): number {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

function readdirCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Why the spool is over its cap, or null when the event may be written. */
export function spoolOverCap(
  spoolDir: string,
  limits: SpoolLimits = {},
  deps: SpoolCapDeps = {},
): 'disk' | 'files' | null {
  const minFree = limits.minFreeBytes ?? SPOOL_MIN_FREE_BYTES;
  const maxFiles = limits.maxFiles ?? SPOOL_MAX_FILES;
  try {
    // The spool dir may not exist yet; its parent (or the data dir) sits on
    // the same disk.
    let probe = spoolDir;
    for (let i = 0; i < 3; i++) {
      try {
        if ((deps.freeBytes ?? statfsFree)(probe) < minFree) return 'disk';
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        probe = dirname(probe);
      }
    }
  } catch {
    // statfs unavailable: no disk verdict.
  }
  try {
    if ((deps.countFiles ?? readdirCount)(spoolDir) > maxFiles) return 'files';
  } catch {
    // unreadable: no file-count verdict.
  }
  return null;
}

/** The counter's path for a spool dir. */
export function spoolDroppedPath(spoolDir: string): string {
  return join(dirname(spoolDir), SPOOL_DROPPED_FILENAME);
}

/** Counts one dropped event: one byte, appended atomically, file 0600. */
export function recordSpoolDrop(counterPath: string): void {
  appendFileSync(counterPath, '.', { flag: 'a', mode: 0o600 });
}
