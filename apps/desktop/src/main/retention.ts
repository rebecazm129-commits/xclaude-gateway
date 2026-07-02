// Retention: audit-log lifecycle for the wrappers/ JSONL trail. Default is
// NEVER delete — the audit trail is the product. Purge is strictly opt-in
// (settings.json), runs only in the MAIN process (a deferred startup pass plus
// a daily interval), never on the renderer's 2s poll. Unit of purge is one
// whole ${session}.jsonl removed with unlink (never in-place rewrite or
// truncate). app-events.jsonl is exempt: it holds the recovery + purge markers.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeAtomic, type WriteAtomicResult } from '@xcg/shared/config';

import type {
  PurgeMode,
  RetentionConfig,
  RetentionPurgedMarker,
  RetentionSizeSnapshot,
} from '../shared/types.js';
import {
  APP_EVENTS_FILENAME,
  RETENTION_PURGED_TYPE,
  writeRetentionPurged,
  type RetentionPurgedFields,
} from './recovery-writer.js';

// Base app dir (sibling of wrappers/); settings.json lives here, NOT inside
// wrappers/, so readAudit's *.jsonl scan never sees it.
export const BASE_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'xCLAUDE Gateway',
);
export const WRAPPERS_DIR = join(BASE_DIR, 'wrappers');
export const SETTINGS_FILENAME = 'settings.json';

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  purgeMode: 'never',
  sizeWarnBytes: 524_288_000, // 500 MiB (marco fijo)
};

const DAY_MS = 24 * 60 * 60 * 1000;

const PURGE_THRESHOLD_MS: Record<Exclude<PurgeMode, 'never'>, number> = {
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  '365d': 365 * DAY_MS,
};

export function isPurgeMode(v: unknown): v is PurgeMode {
  return v === 'never' || v === '30d' || v === '90d' || v === '365d';
}

// Crockford Base32 — the ULID alphabet (excludes I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Decode the 48-bit millisecond timestamp embedded in a 26-char ULID. Returns
// null for anything that is not a valid ULID string. Callers treat null as
// "do not purge" (fail-safe: conserve). Validates all 26 chars so a non-ULID
// filename never decodes to a bogus time.
export function decodeUlidTime(id: string): number | null {
  if (id.length !== 26) return null;
  const s = id.toUpperCase();
  let time = 0;
  for (let i = 0; i < 26; i++) {
    const idx = CROCKFORD.indexOf(s[i]!);
    if (idx === -1) return null;
    if (i < 10) time = time * 32 + idx;
  }
  return time;
}

// A session file is any *.jsonl EXCEPT the desktop-owned app-events.jsonl,
// which is exempt from per-file purge.
export function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') && name !== APP_EVENTS_FILENAME;
}

function sessionBasename(name: string): string {
  return name.slice(0, -'.jsonl'.length);
}

// ---- settings.json (config store) ----

export async function readRetentionConfig(
  baseDir: string = BASE_DIR,
): Promise<RetentionConfig> {
  let raw: string;
  try {
    raw = await readFile(join(baseDir, SETTINGS_FILENAME), 'utf8');
  } catch {
    return { ...DEFAULT_RETENTION_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_RETENTION_CONFIG };
  }
  const ret = (parsed as { retention?: unknown } | null)?.retention;
  const obj = (typeof ret === 'object' && ret !== null ? ret : {}) as Record<
    string,
    unknown
  >;
  const purgeMode = isPurgeMode(obj['purgeMode'])
    ? obj['purgeMode']
    : DEFAULT_RETENTION_CONFIG.purgeMode;
  const rawSize = obj['sizeWarnBytes'];
  const sizeWarnBytes =
    typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize > 0
      ? rawSize
      : DEFAULT_RETENTION_CONFIG.sizeWarnBytes;
  return { purgeMode, sizeWarnBytes };
}

export function writeRetentionConfig(
  config: RetentionConfig,
  baseDir: string = BASE_DIR,
): WriteAtomicResult {
  const path = join(baseDir, SETTINGS_FILENAME);
  try {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    // writeAtomic requires the target to already exist (it stats + backs it up
    // first-write-wins). Seed a default file on cold start so the actual mode
    // change still goes through writeAtomic's fsync-rename-fsync path.
    if (!existsSync(path)) {
      writeFileSync(
        path,
        `${JSON.stringify({ v: 1, retention: DEFAULT_RETENTION_CONFIG }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    const code = (err as NodeJS.ErrnoException).code;
    const kind =
      code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
        ? 'permission'
        : 'io';
    return { ok: false, error: { kind, detail } };
  }
  return writeAtomic(path, { v: 1, retention: config });
}

// ---- directory size (for the "log has grown" banner) ----

export async function computeDirSize(
  dir: string = WRAPPERS_DIR,
): Promise<{ totalBytes: number; fileCount: number }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { totalBytes: 0, fileCount: 0 };
    }
    throw err;
  }
  let totalBytes = 0;
  let fileCount = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) {
        totalBytes += s.size;
        fileCount += 1;
      }
    } catch {
      // deleted mid-scan / unreadable — skip (mirrors readAudit's tolerance).
      continue;
    }
  }
  return { totalBytes, fileCount };
}

// ---- purge (the sweep) ----

interface PurgableFile {
  name: string;
  ulidTimeMs: number;
}

// Age criterion (OBLIGATORIO): age = now - max(decodeTime(ULID), mtime).
// A file counts as purgable only when BOTH its ULID time and its mtime are past
// the cutoff. Non-ULID names are conserved (fail-safe). app-events.jsonl is
// excluded by isSessionFile.
async function collectPurgable(
  dir: string,
  mode: PurgeMode,
  now: number,
): Promise<PurgableFile[]> {
  if (mode === 'never') return [];
  const cutoff = now - PURGE_THRESHOLD_MS[mode];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PurgableFile[] = [];
  for (const name of entries) {
    if (!isSessionFile(name)) continue;
    const ulidTimeMs = decodeUlidTime(sessionBasename(name));
    if (ulidTimeMs === null) continue; // fail-safe: non-ULID → conserve
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(dir, name))).mtimeMs;
    } catch {
      continue; // vanished / unreadable — skip
    }
    const effective = Math.max(ulidTimeMs, mtimeMs);
    if (effective < cutoff) out.push({ name, ulidTimeMs });
  }
  return out;
}

export interface SweepOutcome {
  size: RetentionSizeSnapshot;
  purged: {
    filesPurged: number;
    purgedFromTs: string;
    purgedUntilTs: string;
  } | null;
  // Filenames actually unlinked this pass (empty when none). The caller passes
  // these to AuditStore.invalidate so the removed sessions drop immediately.
  purgedFiles: string[];
}

// Runs one sweep: purges (if opted in) then recomputes the cached size. Emits
// exactly ONE aggregated app.retention_purged marker per pass that removed ≥1
// file. `emit` is injectable for tests; production defaults to writeRetentionPurged.
export async function runSweep(
  dir: string,
  config: RetentionConfig,
  now: number,
  emit: (fields: RetentionPurgedFields) => void = (f) =>
    writeRetentionPurged(f, dir),
): Promise<SweepOutcome> {
  let purged: SweepOutcome['purged'] = null;
  const purgedFiles: string[] = [];
  if (config.purgeMode !== 'never') {
    const targets = await collectPurgable(dir, config.purgeMode, now);
    const removedTimes: number[] = [];
    for (const t of targets) {
      try {
        await unlink(join(dir, t.name));
        removedTimes.push(t.ulidTimeMs);
        purgedFiles.push(t.name);
      } catch {
        // Already gone / unreadable — skip; a single failure never fails the sweep.
        continue;
      }
    }
    if (removedTimes.length >= 1) {
      const minMs = Math.min(...removedTimes);
      const maxMs = Math.max(...removedTimes);
      const fields: RetentionPurgedFields = {
        filesPurged: removedTimes.length,
        purgedFromTs: new Date(minMs).toISOString(),
        purgedUntilTs: new Date(maxMs).toISOString(),
        purgeMode: config.purgeMode,
      };
      emit(fields);
      purged = {
        filesPurged: fields.filesPurged,
        purgedFromTs: fields.purgedFromTs,
        purgedUntilTs: fields.purgedUntilTs,
      };
    }
  }
  const { totalBytes, fileCount } = await computeDirSize(dir);
  return {
    size: { totalBytes, fileCount, computedAtTs: new Date(now).toISOString() },
    purged,
    purgedFiles,
  };
}

// Count of session files that WOULD be purged at `mode`, by ULID decodeTime
// ONLY (no stat, nothing deleted). Lets set-mode report impact before the next
// sweep. Deliberately looser than the sweep (which also honors mtime).
export async function estimatePurgable(
  dir: string,
  mode: PurgeMode,
  now: number,
): Promise<number> {
  if (mode === 'never') return 0;
  const cutoff = now - PURGE_THRESHOLD_MS[mode];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const name of entries) {
    if (!isSessionFile(name)) continue;
    const t = decodeUlidTime(sessionBasename(name));
    if (t === null) continue;
    if (t < cutoff) count += 1;
  }
  return count;
}

// ---- last purge marker (for Settings "last cleanup" line) ----

export async function readLastPurgeMarker(
  dir: string = WRAPPERS_DIR,
): Promise<RetentionPurgedMarker | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
  } catch {
    return null;
  }
  let last: RetentionPurgedMarker | null = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const o = parsed as Record<string, unknown>;
    if (o['type'] !== RETENTION_PURGED_TYPE) continue;
    if (typeof o['ts'] !== 'string') continue;
    // Append-only → a later line supersedes; keep scanning to the end.
    last = {
      ts: o['ts'],
      filesPurged: typeof o['filesPurged'] === 'number' ? o['filesPurged'] : 0,
      purgedFromTs:
        typeof o['purgedFromTs'] === 'string' ? o['purgedFromTs'] : '',
      purgedUntilTs:
        typeof o['purgedUntilTs'] === 'string' ? o['purgedUntilTs'] : '',
      purgeMode: typeof o['purgeMode'] === 'string' ? o['purgeMode'] : '',
    };
  }
  return last;
}
