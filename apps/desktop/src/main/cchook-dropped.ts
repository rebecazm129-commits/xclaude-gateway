// Events xcg-cchook did not record because the spool was over its cap
// (cchook-cap.ts): the hook appends one byte per drop to
// claude-code/spool-dropped. Each ingest cycle takes that counter — rename,
// so hooks dropping meanwhile start a fresh file — records it in the trail as
// app.spool_dropped, adds it to the "not yet seen" total the Claude Code tab
// shows, and removes the taken file. A crash between those steps leaves the
// taken file, which the next cycle picks up again (at worst a line twice,
// never a drop lost).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { writeAtomic } from '@xcg/shared/config';

import { writeSpoolDropped } from './recovery-writer.js';
import type { SpoolDroppedNotice } from '../shared/types.js';

export const UNSEEN_DROPPED_FILENAME = 'spool-dropped-unseen.json';
const TAKING = '.taking.';

// Same as the ingester's persistJson (seed on first write, then atomic) —
// repeated here so this module does not import the ingester, which imports it.
function persist(path: string, value: unknown): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const res = writeAtomic(path, value);
  if (!res.ok) console.error(`cchook-dropped: failed to persist ${path}: ${res.error.kind}`);
}

interface Taken {
  count: number;
  firstTs?: string;
  lastTs?: string;
  files: string[];
}

// The counter plus any taken file a previous cycle left behind.
function take(counterPath: string): Taken {
  const dir = dirname(counterPath);
  const name = basename(counterPath);
  try {
    renameSync(counterPath, `${counterPath}${TAKING}${process.pid}.${Date.now()}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(`${name}${TAKING}`)).map((f) => join(dir, f));
  } catch {
    return { count: 0, files: [] };
  }
  let count = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const f of files) {
    const st = statSync(f);
    count += st.size;
    if (st.size === 0) continue;
    // Birth = first drop since the counter was last taken; mtime = last drop.
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    first = first === undefined ? born : Math.min(first, born);
    last = last === undefined ? st.mtimeMs : Math.max(last, st.mtimeMs);
  }
  return {
    count,
    ...(first !== undefined ? { firstTs: new Date(first).toISOString() } : {}),
    ...(last !== undefined ? { lastTs: new Date(last).toISOString() } : {}),
    files,
  };
}

export function readUnseenDropped(stateDir: string): SpoolDroppedNotice | null {
  try {
    const o = JSON.parse(readFileSync(join(stateDir, UNSEEN_DROPPED_FILENAME), 'utf8')) as Record<string, unknown>;
    if (typeof o['count'] !== 'number' || o['count'] <= 0) return null;
    return {
      count: o['count'],
      ...(typeof o['firstTs'] === 'string' ? { firstTs: o['firstTs'] } : {}),
      ...(typeof o['lastTs'] === 'string' ? { lastTs: o['lastTs'] } : {}),
    };
  } catch {
    return null;
  }
}

/** One pass: take the counter; if anything was dropped, trail line, unseen
 *  total, then remove the taken files. Returns the count taken. */
export function processSpoolDropped(counterPath: string, stateDir: string, wrappersDir: string): number {
  const taken = take(counterPath);
  if (taken.files.length === 0) return 0;
  if (taken.count > 0) {
    const fields = {
      count: taken.count,
      ...(taken.firstTs !== undefined ? { firstTs: taken.firstTs } : {}),
      ...(taken.lastTs !== undefined ? { lastTs: taken.lastTs } : {}),
    };
    // Not in the trail → keep the taken files for the next cycle.
    if (!writeSpoolDropped(fields, wrappersDir)) return 0;
    const prev = readUnseenDropped(stateDir);
    persist(join(stateDir, UNSEEN_DROPPED_FILENAME), {
      count: (prev?.count ?? 0) + taken.count,
      ...((prev?.firstTs ?? taken.firstTs) !== undefined ? { firstTs: prev?.firstTs ?? taken.firstTs } : {}),
      ...(taken.lastTs !== undefined ? { lastTs: taken.lastTs } : prev?.lastTs !== undefined ? { lastTs: prev.lastTs } : {}),
    });
  }
  for (const f of taken.files) {
    try {
      unlinkSync(f);
    } catch {
      // already gone
    }
  }
  return taken.count;
}

/** The Claude Code tab's Dismiss: the notice has been seen. */
export function dismissUnseenDropped(stateDir: string): void {
  persist(join(stateDir, UNSEEN_DROPPED_FILENAME), { count: 0 });
}
