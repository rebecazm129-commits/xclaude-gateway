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

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DetectionCursor,
  DetectionDetail,
  DetectionEnrichmentEvent,
  DetectionEvent,
  DetectionFilter,
  DetectionListResult,
  EnrichableEvent,
} from '../shared/types.js';
import {
  assembleAudit,
  parseAuditContent,
  type AuthSignal,
  type ParsedFile,
} from './detection-reader.js';
import { paginate, toDetail, type PageSlice } from './detection-page.js';

export interface DetectionPageParams {
  filter: DetectionFilter;
  limit: number;
  cursor: DetectionCursor | null;
}

// PageSlice plus the passthrough authAlerts. Retention is added by the handler.
export type StorePage = PageSlice & {
  authAlerts: DetectionListResult['authAlerts'];
};

export interface AuditStore {
  // Refreshes the cache incrementally and returns the full current result.
  get(): Promise<DetectionListResult>;
  // Filtered + paginated slim page over the full set (filters applied before the
  // cut). authAlerts pass through; retention is added by the IPC handler.
  getPage(params: DetectionPageParams): Promise<StorePage>;
  // Heavy detail for one event by id, or null if it's no longer present.
  getDetail(id: string): Promise<DetectionDetail | null>;
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
  events: EnrichableEvent[]; // LEAN (see slimEvent) — no argumentsJson/params
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

// Projects a parsed event to the LEAN shape kept in the cache: only the fields
// the list/filters/counts/correlation need. Drops the heavy fields (argumentsJson,
// overheadUs, and the raw JSON siblings like params/bytes that JSON.parse leaves
// on the object) so 1M cached events stay small. The full detail is reconstructed
// on demand by re-reading the source line (getDetail). detection (small) is kept
// by reference; the heavy fields live on the discarded parent object and get GC'd.
function slimEvent(e: EnrichableEvent): EnrichableEvent {
  if (e.type === 'mcp.request') {
    const slim: DetectionEvent = {
      id: e.id,
      ts: e.ts,
      session: e.session,
      mcp: e.mcp,
      type: 'mcp.request',
      method: e.method,
      rpcId: e.rpcId,
      direction: e.direction,
      detection: e.detection,
    };
    if (e.toolName !== undefined) slim.toolName = e.toolName;
    // Raw provenance field (F1.3b): the source filter/badge read it via
    // normalizeSource downstream — dropping it here made every cached event
    // read as 'gateway' (F1.3c-fix). Tiny (a short string on cc events only).
    if (e.source !== undefined) slim.source = e.source;
    return slim;
  }
  const slim: DetectionEnrichmentEvent = {
    id: e.id,
    ts: e.ts,
    session: e.session,
    mcp: e.mcp,
    type: 'mcp.detection_enrichment',
    rpcId: e.rpcId,
    direction: e.direction,
    detection: e.detection,
  };
  if (e.source !== undefined) slim.source = e.source;
  return slim;
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
        // Store the LEAN form only — heavy fields are re-read on demand.
        for (const ev of parsed.events) entry.events.push(slimEvent(ev));
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

  async function getPage(params: DetectionPageParams): Promise<StorePage> {
    const full = await get();
    const slice = paginate(
      full.events,
      params.filter,
      params.limit,
      params.cursor,
      now(),
    );
    return { ...slice, authAlerts: full.authAlerts };
  }

  async function getDetail(id: string): Promise<DetectionDetail | null> {
    // Keep the cache coherent first (drops purged/invalidated files). The cache
    // is slim, so we can't build the heavy detail from it — instead we locate the
    // source file via the id-in-cache index and re-read that ONE file. Locating
    // by id (not a byte offset) is naturally robust to fail-safe re-reads, which
    // rebuild entry.events from current file content.
    await get();
    let file: string | null = null;
    for (const [name, entry] of cache) {
      if (entry.events.some((e) => e.id === id)) {
        file = name;
        break;
      }
    }
    if (file === null) return null;
    let content: string;
    try {
      content = await readFile(join(dir, file), 'utf8');
    } catch {
      // Purged/unreadable between locate and read → cleanly unavailable.
      return null;
    }
    const event = parseAuditContent(content).events.find((e) => e.id === id);
    return event ? toDetail(event) : null;
  }

  function invalidate(filenames: readonly string[]): void {
    for (const name of filenames) pendingInvalidations.add(name);
    if (filenames.length > 0) dirty = true;
  }

  return { get, getPage, getDetail, invalidate };
}
