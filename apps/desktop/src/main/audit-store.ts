// AuditStore: incremental, cached reader over the wrappers/ JSONL trail. Lives
// in the MAIN process and is the single source of truth shared by detection:list
// (2s poll), the tray loop (60s) and the retention sweep — collapsing the
// previous three independent full re-reads into one warm cache.
//
// Per file we keep { size, offset, pendingTail, mtimeMs, events, authSignals }.
// Change signal is SIZE (append-only ULID files grow strictly); mtime is only a
// secondary tie-breaker. Only the bytes in [offset, size) are read and parsed;
// a trailing partial line (no '\n' yet) is stashed in pendingTail until it
// completes. Any inconsistency (truncation, same-size-different-mtime rewrite,
// read error) degrades to a fail-safe full re-read of THAT file only — never
// corrupt data, never the whole audit blanked.
//
// The full result is rebuilt each get() via the shared, pure assembleAudit,
// which correlates and sorts over COPIES — entry.events is never mutated.

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DetectionListResult, EnrichableEvent } from '../shared/types.js';
import {
  assembleAudit,
  parseAuditContent,
  type AuthSignal,
  type ParsedFile,
} from './detection-reader.js';

export interface AuditStore {
  // Refreshes the cache incrementally and returns the full current result.
  get(): Promise<DetectionListResult>;
  // Marks files removed out-of-band (e.g. the retention sweep's unlink) so the
  // next get() drops their events immediately, bypassing the refresh window.
  invalidate(filenames: readonly string[]): void;
}

export interface AuditStoreOptions {
  // Refresh coalescing window: a get() within this many ms of the last refresh
  // returns the cached result without touching disk. Default 250ms. 0 disables.
  minRefreshMs?: number;
  // authAlerts clock (24h window). Default Date.now.
  now?: () => number;
  // Coalescing clock. Default Date.now. Separate from `now` so tests can fix the
  // authAlerts time without freezing the refresh window.
  monotonic?: () => number;
  // Test hook: invoked after each disk read with the byte range consumed.
  onRead?: (name: string, from: number, to: number) => void;
}

interface FileCacheEntry {
  size: number; // == offset: last byte position read
  offset: number; // next read starts here
  pendingTail: string; // decoded bytes after the last '\n' (unparsed partial)
  mtimeMs: number;
  events: EnrichableEvent[];
  authSignals: AuthSignal[];
}

function newEntry(): FileCacheEntry {
  return {
    size: 0,
    offset: 0,
    pendingTail: '',
    mtimeMs: 0,
    events: [],
    authSignals: [],
  };
}

async function readRange(
  path: string,
  from: number,
  to: number,
): Promise<string> {
  const len = to - from;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function createAuditStore(
  dir: string,
  opts: AuditStoreOptions = {},
): AuditStore {
  const minRefreshMs = opts.minRefreshMs ?? 250;
  const now = opts.now ?? ((): number => Date.now());
  const monotonic = opts.monotonic ?? ((): number => Date.now());
  const onRead = opts.onRead;

  const cache = new Map<string, FileCacheEntry>();
  const pendingInvalidations = new Set<string>();
  let lastResult: DetectionListResult | null = null;
  let lastRefreshAt = -Infinity;
  let dirty = false; // an invalidation is pending → force next refresh
  let inFlight: Promise<DetectionListResult> | null = null;

  async function listJsonl(): Promise<string[]> {
    try {
      const entries = await readdir(dir);
      return entries.filter((name) => name.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  // Brings one file's cache entry up to date. Returns the entry, or null when
  // the file should contribute nothing this pass (vanished / unreadable —
  // mirrors readAudit's per-file skip).
  async function refreshFile(name: string): Promise<FileCacheEntry | null> {
    const path = join(dir, name);
    let st;
    try {
      st = await stat(path);
    } catch {
      cache.delete(name); // vanished mid-scan / stat error
      return null;
    }
    const size = st.size;
    const mtimeMs = st.mtimeMs;

    let entry = cache.get(name);
    if (entry) {
      if (size < entry.size) {
        // Truncated / rewritten shorter → fail-safe full re-read.
        entry = undefined;
      } else if (size === entry.size) {
        if (mtimeMs === entry.mtimeMs) return entry; // no change
        // Same length, different mtime → fail-safe full re-read (rewrite).
        entry = undefined;
      }
      // else size > entry.size → incremental read below.
    }
    if (!entry) {
      cache.delete(name);
      entry = newEntry();
    }

    if (size > entry.offset) {
      const from = entry.offset;
      let chunk: string;
      try {
        chunk = await readRange(path, from, size);
      } catch {
        // Read error (e.g. EISDIR on a dir named *.jsonl, or a race) → fail-safe:
        // drop the entry and skip this pass; next pass re-reads from scratch.
        cache.delete(name);
        return null;
      }
      onRead?.(name, from, size);
      const combined = entry.pendingTail + chunk;
      const lastNl = combined.lastIndexOf('\n');
      if (lastNl === -1) {
        // No complete line yet — keep it all pending.
        entry.pendingTail = combined;
      } else {
        const complete = combined.slice(0, lastNl + 1);
        entry.pendingTail = combined.slice(lastNl + 1);
        const parsed = parseAuditContent(complete);
        if (parsed.events.length > 0) entry.events.push(...parsed.events);
        if (parsed.authSignals.length > 0) {
          entry.authSignals.push(...parsed.authSignals);
        }
      }
      entry.offset = size;
    }
    entry.size = size;
    entry.mtimeMs = mtimeMs;
    cache.set(name, entry);
    return entry;
  }

  async function refresh(): Promise<DetectionListResult> {
    // Apply out-of-band invalidations first.
    for (const name of pendingInvalidations) cache.delete(name);
    pendingInvalidations.clear();
    dirty = false;

    const files = await listJsonl();
    const present = new Set(files);
    // Drop vanished files (purge / manual delete).
    for (const name of [...cache.keys()]) {
      if (!present.has(name)) cache.delete(name);
    }
    // Refresh each file in readdir order and collect its contribution in that
    // same order (matches readAudit's ordering exactly).
    const parsedFiles: ParsedFile[] = [];
    for (const name of files) {
      const entry = await refreshFile(name);
      if (entry) {
        parsedFiles.push({ events: entry.events, authSignals: entry.authSignals });
      }
    }
    const result = assembleAudit(parsedFiles, now());
    lastResult = result;
    lastRefreshAt = monotonic();
    return result;
  }

  function get(): Promise<DetectionListResult> {
    // Time-window coalescing: skip disk if a fresh result exists and no
    // invalidation is pending.
    if (
      !dirty &&
      lastResult !== null &&
      monotonic() - lastRefreshAt < minRefreshMs
    ) {
      return Promise.resolve(lastResult);
    }
    // In-flight sharing: concurrent callers ride the same refresh.
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function invalidate(filenames: readonly string[]): void {
    for (const name of filenames) pendingInvalidations.add(name);
    if (filenames.length > 0) dirty = true;
  }

  return { get, invalidate };
}
