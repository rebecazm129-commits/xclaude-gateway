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
  maskCredentials,
  parseHookPayload,
  readMaskSecrets,
  resolveAuditKey,
  synthesize,
} from '@xcg/proxy/cchook-ingest';

import { BASE_DIR, WRAPPERS_DIR, decodeUlidTime } from './retention.js';
import { runCompactionCycle } from './compactor.js';
import type { CchookIngestStatus } from '../shared/types.js';

const SPOOL_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

// Credential-masking key, resolved once per desktop process from the SAME
// baseDir/audit-salt the wrappers use — so a credential fingerprints
// identically whether it was seen on the wire (b.1) or via a Claude Code hook
// (b.2). resolveAuditKey never throws (ephemeral fallback), so this is a
// Buffer, never null. Resolved LAZILY and only when a batch actually carries a
// credential, so the common (clean) path never touches the salt file.
let auditKey: Buffer | null = null;
function getAuditKey(override?: Buffer): Buffer {
  if (override !== undefined) return override;
  if (auditKey === null) auditKey = resolveAuditKey(BASE_DIR);
  return auditKey;
}
/** Session-map bucket for captures whose payload carries no session_id. */
const UNKNOWN_SESSION_KEY = '__unknown__';

export interface CchookIngesterPaths {
  spoolDir?: string;
  wrappersDir?: string;
  /** Dir holding sessions.json / ingest-state.json (default: spool's parent). */
  stateDir?: string;
  /** Override the credential-masking key (tests: a fixture salt, so the real
   *  ~/.../audit-salt is never touched). Production omits it → resolveAuditKey
   *  from BASE_DIR, shared with the wrappers. */
  hmacKey?: Buffer;
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

// ---- accumulated status (F1.3c) — read by the cchook:status IPC handler. ----
// In-memory, per process; lastSessionStartTs additionally rides the
// ingest-state.json writes the cycle already does (trivial: same object, same
// persistJson call) so a restart doesn't blank the heartbeat.
let lastCycle: CchookIngestStatus['lastCycle'] = null;
let unreadableTotal = 0;
let lastSessionStartTs: string | null = null;

export function getCchookStatus(): CchookIngestStatus {
  return { lastCycle, unreadableTotal, lastSessionStartTs };
}

/** Test seam: module-level accumulators survive between vitest cases. */
export function resetCchookStatusForTests(): void {
  lastCycle = null;
  unreadableTotal = 0;
  lastSessionStartTs = null;
}

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
    lastCycle = { ...result, ts: new Date().toISOString() };
    unreadableTotal += result.skippedUnreadable;
  }
}

async function drainSpool(
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
  // Heartbeat restart-seed: memory is empty on a fresh process; the persisted
  // value from a previous run is still the newest known SessionStart.
  if (lastSessionStartTs === null && typeof state['lastSessionStartTs'] === 'string') {
    lastSessionStartTs = state['lastSessionStartTs'] as string;
  }

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
    // Third accepted window (F1.3c finding): an unreadable spool file that got
    // skipped while a LATER file advanced the watermark ends up below it and
    // is deleted on the next cycle without ever being ingested — a rare,
    // bounded loss, visible in unreadableTotal. The alternative (holding the
    // watermark back / tracking a skipped-set) was rejected: it would demand a
    // retry policy and a poison-file cap for what the counter already surfaces.
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

      // Heartbeat route (a): a SessionStart capture IS the "Claude Code was
      // alive at T" signal — no reader change needed (cc.event lines are
      // invisible to the dashboard reader by design).
      if (parsed.kind === 'hook' && parsed.hookEventName === 'SessionStart') {
        lastSessionStartTs = new Date(captureTimeMs).toISOString();
      }

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
      // Serialize; mask per envelope carrying credential values (the classify
      // step tagged them via the Symbol channel). A clean envelope is
      // byte-identical to before b.2. The key is resolved ONLY when the batch
      // has a secret, so clean batches never touch the salt file.
      const hasSecret = envelopes.some((e) => (readMaskSecrets(e)?.length ?? 0) > 0);
      const key = hasSecret ? getAuditKey(paths.hmacKey) : null;
      const lines = `${envelopes
        .map((e) => {
          const line = JSON.stringify(e);
          const secrets = readMaskSecrets(e);
          return key !== null && secrets !== undefined && secrets.length > 0
            ? maskCredentials(line, secrets, key)
            : line;
        })
        .join('\n')}\n`;
      await appendWithFsync(join(wrappersDir, `${sessionUlid}.jsonl`), lines);

      lastProcessed = spoolUlid;
      persistJson(statePath, {
        lastProcessedSpoolUlid: lastProcessed,
        ...(lastSessionStartTs !== null ? { lastSessionStartTs } : {}),
      });

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

async function ingestCycle(
  paths: CchookIngesterPaths,
  result: IngestCycleResult,
): Promise<IngestCycleResult> {
  const wrappersDir = paths.wrappersDir ?? WRAPPERS_DIR;
  try {
    return await drainSpool(paths, result);
  } finally {
    // F2.2: compact terminated session files each ingest tick
    // (independent of spool activity — wrapper-only trails need
    // compaction too). Contained (hallazgo B, auditoría 22/07): a throw
    // here would MASK a drainSpool error in flight (a finally that
    // throws replaces the original exception) and would abort the
    // ingest result — compaction failures are logged, never fatal.
    try {
      await runCompactionCycle(wrappersDir, Date.now());
    } catch (err) {
      console.error('compaction cycle failed:', err);
    }
  }
}
