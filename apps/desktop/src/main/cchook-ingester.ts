// cchook-ingester — fs orchestration for the Claude Code spool (F1.2). Runs in
// the desktop MAIN process: drains claude-code/spool/ (written by xcg-cchook),
// translates each capture through the pure @xcg/proxy/cchook-ingest module and
// appends the resulting envelopes to the same wrappers/ JSONL trail the
// AuditStore reads. State lives next to the spool:
//   claude-code/sessions.json     — Claude Code session UUID → session ULID
//                                   (names wrappers/<ulid>.jsonl; stable across
//                                   cycles and app restarts)
//   claude-code/ingest-state.json — { lastProcessedSpoolUlid } for idempotence
//
// Crash-safety model (per file: append → state → unlink):
//   - crash between state-write and unlink → next cycle sees ULID ≤
//     lastProcessed and deletes WITHOUT reprocessing (no duplicate).
//   - crash between append and state-write → next cycle reprocesses and appends
//     a duplicate pair with fresh ids. ACCEPTED window (F1.2): favors
//     never-losing-a-capture over never-duplicating; the reader dedups by id so
//     rows render, just twice, until F1.3 adds spool-level dedup if dogfooding
//     shows it matters.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { open, readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { monotonicFactory, ulid } from 'ulid';

import { writeAtomic } from '@xcg/shared/config';
import {
  cchookSpoolDir,
  classify,
  parseHookPayload,
  synthesize,
} from '@xcg/proxy/cchook-ingest';

import { WRAPPERS_DIR, decodeUlidTime } from './retention.js';

const SPOOL_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;
/** Session-map bucket for captures whose payload carries no session_id. */
const UNKNOWN_SESSION_KEY = '__unknown__';

export interface CchookIngesterPaths {
  spoolDir?: string;
  wrappersDir?: string;
  /** Dir holding sessions.json / ingest-state.json (default: spool's parent). */
  stateDir?: string;
}

export interface IngestCycleResult {
  processed: number;
  skippedUnreadable: number;
  deletedStale: number;
}

// sessions.json / ingest-state.json may not exist yet: writeAtomic requires an
// existing target (it stats it and captures a first-write-wins .bak), so the
// FIRST write seeds the file with writeFileSync (0o600, parent mkdir), and
// every later write goes through writeAtomic (F1.2 v2 point 3).
function persistJson(path: string, value: unknown): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const res = writeAtomic(path, value);
  if (!res.ok) {
    console.error(`cchook-ingester: failed to persist ${path}: ${res.error.kind}`);
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Append with fsync: the envelopes must be durable BEFORE the state advances
// past their spool file — same last-event-persistence spirit as the wrapper's
// shutdown fsync.
async function appendWithFsync(path: string, data: string): Promise<void> {
  const fd = await open(path, 'a', 0o600);
  try {
    await fd.writeFile(data, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
}

// Overlap guard: cycles are re-entrant-unsafe by design (shared state files);
// if a 15s tick fires while the previous cycle still runs, skip it.
let cycleRunning = false;

export async function runCchookIngestCycle(
  paths: CchookIngesterPaths = {},
): Promise<IngestCycleResult> {
  const result: IngestCycleResult = { processed: 0, skippedUnreadable: 0, deletedStale: 0 };
  if (cycleRunning) return result;
  cycleRunning = true;
  try {
    return await ingestCycle(paths, result);
  } finally {
    cycleRunning = false;
  }
}

async function ingestCycle(
  paths: CchookIngesterPaths,
  result: IngestCycleResult,
): Promise<IngestCycleResult> {
  const spoolDir = paths.spoolDir ?? cchookSpoolDir();
  const wrappersDir = paths.wrappersDir ?? WRAPPERS_DIR;
  const stateDir = paths.stateDir ?? dirname(spoolDir);
  const sessionsPath = join(stateDir, 'sessions.json');
  const statePath = join(stateDir, 'ingest-state.json');

  let entries: string[];
  try {
    entries = await readdir(spoolDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result; // no spool yet
    throw err;
  }
  // ULID names sort lexicographically === chronologically.
  const spoolFiles = entries.filter((name) => SPOOL_ULID_RE.test(name)).sort();
  if (spoolFiles.length === 0) return result;

  const sessions = (await readJsonObject(sessionsPath)) ?? {};
  const state = (await readJsonObject(statePath)) ?? {};
  let lastProcessed =
    typeof state['lastProcessedSpoolUlid'] === 'string'
      ? (state['lastProcessedSpoolUlid'] as string)
      : null;

  const nextId = monotonicFactory();

  for (const name of spoolFiles) {
    const spoolUlid = name.slice(0, -'.json'.length);
    const spoolPath = join(spoolDir, name);

    // Idempotence: already recorded as processed (crash happened between the
    // state-write and the unlink) → delete WITHOUT reprocessing.
    // Theoretical sub-ms window: a capture from the SAME millisecond as
    // lastProcessed whose ULID random part sorts LOWER, landing after our
    // readdir, would be deleted here unprocessed — one lost capture. Accepted
    // by contract, like the append→state duplicate window above: both trade a
    // vanishing edge case for a simple, crash-safe ordering rule.
    if (lastProcessed !== null && spoolUlid <= lastProcessed) {
      try {
        await unlink(spoolPath);
        result.deletedStale++;
      } catch (err) {
        console.error(`cchook-ingester: failed to delete stale spool ${name}:`, err);
      }
      continue;
    }

    try {
      const bytes = await readFile(spoolPath);
      const parsed = parseHookPayload(bytes);
      const captureTimeMs = decodeUlidTime(spoolUlid) ?? Date.now();

      // Stable UUID → ULID mapping; persisted immediately so a crash mid-cycle
      // never re-buckets a session on the next run.
      const sessionKey =
        parsed.kind === 'hook' && parsed.sessionId !== undefined
          ? parsed.sessionId
          : UNKNOWN_SESSION_KEY;
      let sessionUlid = typeof sessions[sessionKey] === 'string' ? (sessions[sessionKey] as string) : undefined;
      if (sessionUlid === undefined) {
        sessionUlid = ulid();
        sessions[sessionKey] = sessionUlid;
        persistJson(sessionsPath, sessions);
      }

      const envelopes = classify(
        synthesize(parsed, { sessionUlid, captureTimeMs, nextId }),
        parsed,
        nextId,
      );

      mkdirSync(wrappersDir, { recursive: true });
      const lines = `${envelopes.map((e) => JSON.stringify(e)).join('\n')}\n`;
      await appendWithFsync(join(wrappersDir, `${sessionUlid}.jsonl`), lines);

      lastProcessed = spoolUlid;
      persistJson(statePath, { lastProcessedSpoolUlid: lastProcessed });

      await unlink(spoolPath);
      result.processed++;
    } catch (err) {
      // Unreadable spool file (fs error): log, SKIP without deleting — it gets
      // retried next cycle. Counter feeds F1.3's health surface.
      console.error(`cchook-ingester: skipping unreadable spool ${name}:`, err);
      result.skippedUnreadable++;
    }
  }
  return result;
}
