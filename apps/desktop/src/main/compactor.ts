// compactor — F2.2 audit trail compaction.
//
// Single-writer invariant: this module runs ONLY in the desktop main
// process, called from the cchook ingest cycle AFTER a successful drain of
// the spool. Never called from the renderer, never from a worker. The
// wrapper processes never touch these files after their proxy.shutdown /
// proxy.child_exited terminal event — the same invariant that lets us
// unlink them here.
//
// What it does, per cycle:
//   1. Scan wrappers/ for candidate session files (see isCandidate below).
//   2. Group candidates by day (UTC), keyed by the day's synthetic ULID.
//   3. For each group: append the candidate lines verbatim to the day file
//      (creating it if missing), fsync, then unlink each source only after
//      a freshness re-stat confirms it did not grow during the append.
//   4. Idempotence: before appending, load the ids already present in the
//      day file for this batch and skip any source line whose id matches.
//      A crash between append and unlink leaves duplicates the reader
//      collapses by id (detection-reader assembleAudit), and the next
//      cycle reconciles by skipping ids already written.
//
// Candidate rules (a file is compactable iff ONE of these holds):
//   - Wrapper terminal: contains a proxy.shutdown or proxy.child_exited
//     line (any position — presence, not order).
//   - Claude Code terminal: contains a cc.event line with
//     hookEventName === 'SessionEnd'.
//   - Silence fallback: mtime is older than 7 days (covers kill -9 /
//     crashes with no terminal event).
// Non-candidates:
//   - app-events.jsonl (desktop-owned, excluded by isSessionFile).
//   - Day files themselves (their basename ULID timestamp is 00:00Z with
//     the reserved tail — see dayFileUlid — so they never match the
//     candidate scan by construction).
//   - Non-ULID basenames (fail-safe: conserve).
//
// Residual F1.2 window (documented, not fixed here):
//   The cchook ingester's accepted crash window (append → state → unlink)
//   may re-emit an already-processed capture with FRESH ids after a
//   session file has been compacted and unlinked. That capture will
//   recreate the session file with new ids that DO NOT collide with the
//   ids already in the day file — the reader will render it twice. This
//   closes automatically when F2.3 replaces id-based dedup with
//   claudecode/toolUseId dedup. Rare (crash-in-window on an already-
//   compacted session) and no data loss; noted so a future reader is not
//   surprised.

import { open, readdir, stat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isSessionFile, decodeUlidTime } from './retention.js';

export interface CompactionOutcome {
  filesCompacted: number; // originals unlinked this cycle
  filesSkippedFreshness: number; // grew during append → not unlinked
  linesAppended: number; // net (after id-dedup against day file)
  linesSkippedDuplicate: number; // ids already present in day file
  dayFilesTouched: readonly string[]; // basenames, for logging
}

export interface CandidateEntry {
  name: string; // basename, e.g. "01AAAA...jsonl"
  content: string; // full file contents
  mtimeMs: number;
  ulidTimeMs: number; // decoded from basename
  freshness: FreshnessToken; // 4-leg token captured at scan
                             // (replaces the earlier `size: number`
                             // — see FreshnessToken above).
}

export interface CompactionPlan {
  // key = dayStartMs (UTC 00:00Z, floor(ulidTimeMs / DAY_MS) * DAY_MS)
  // value = candidates whose ulid falls on that UTC day
  groups: Map<number, CandidateEntry[]>;
}

// Freshness token: four legs of stat metadata, all bigint straight
// from stat({ bigint: true }). A conflict if ANY moved. Same pattern
// as @xcg/shared config-cc writer.ts (F2.1c re-audit), replicated
// here rather than imported: config-cc's writer is a tool for writing
// Claude Code configs, semantically unrelated to compaction — coupling
// the compactor to that module would be spurious. The 4-leg discipline
// is the shared contract, not the interface name.
//
// Why four legs: mtime is forgeable from userland (utimes); size only
// saves you when the total byte count changes (a same-length
// rewrite passes); ino ALWAYS changes under atomic rename-writers;
// ctime cannot be set from userland. Same combination Git's index
// compares to catch racy changes (mtime+ctime+ino+size).
//
// Semantic difference vs F2.1c writer: F2.1c compares two captures
// of the same file that WE JUST WROTE (before/after our own atomic
// rename). The compactor compares two captures of a file WE ONLY
// READ — the interval between captures includes a full readFile().
// On APFS/ext4 a pure read updates only atime, not ctime (verified),
// so ctime remains a valid conflict signal in our setting. On more
// exotic filesystems where atime propagates to ctime, we may see
// false positives (source marked as changed, not unlinked this
// cycle, retried next cycle) — self-healing, no data loss.
export interface FreshnessToken {
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  size: bigint;
}

function sameFreshness(a: FreshnessToken, b: FreshnessToken): boolean {
  return (
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.ino === b.ino &&
    a.size === b.size
  );
}

// ---- day-file naming --------------------------------------------------------

// Crockford Base32 — the ULID alphabet (excludes I, L, O, U). Mirrors the
// module-private CROCKFORD in retention.ts; the two MUST agree, and the shared
// contract is exercised in the unit tests by round-tripping through the
// exported decodeUlidTime (retention.ts) — the exact inverse of the encode
// below over positions 0..9.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// One UTC day in milliseconds. Shared by the silence fallback below and the
// (TODO) day-grouping step.
const DAY_MS = 24 * 60 * 60 * 1000;

// The reserved 16-char ULID tail marking a basename as a day file rather than a
// real session. A standard ULID is 10 timestamp chars + 16 random chars; here
// the random tail is fixed to all-zero (see dayFileUlid for why).
const DAY_FILE_TAIL = '0'.repeat(16);

// Encode a 48-bit millisecond timestamp as the 10 leading ULID characters
// (big-endian Crockford Base32). This is the exact inverse of retention.ts's
// decodeUlidTime over positions 0..9: decodeUlidTime reads chars 0..9 as
// `time = time * 32 + idx`, so we emit the same big-endian digits.
function encodeCrockfordTime48(ms: number): string {
  let t = ms;
  const chars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  return chars.join('');
}

// dayFileUlid — synthetic, VALID ULID naming a day's compacted file.
//
// Timestamp: dayStartMs (00:00:00.000Z of the target UTC day) in the 10 leading
// chars; the 16-char tail is FIXED to DAY_FILE_TAIL ('0'*16). Total 26 chars,
// all in the Crockford alphabet, so decodeUlidTime(basename) === dayStartMs.
//
// Why a real ULID timestamp at 00:00Z: the retention sweep purges by
// decodeUlidTime(basename). A day file whose ULID time is that day's midnight is
// purged by the STANDARD sweep exactly when the whole date has fallen outside
// the retention window — the compacted trail inherits retention with no
// special-casing. (Verified against retention.ts: isSessionFile treats any
// *.jsonl that is not app-events.jsonl as a session file, day files included, so
// nothing in retention.ts needs to change; collectPurgable/estimatePurgable
// already decode this basename correctly.)
//
// Why a reserved (all-zero) tail: a genuine ulid() minted at 00:00Z would carry
// an 80-bit random tail and be indistinguishable from a session file that merely
// started at midnight. The zero tail is a construction marker — "this is a day
// file, not a session" — that lets the candidate scan exclude day files by
// basename, and makes an accidental collision with a real session ULID (whose
// random tail would have to be exactly zero) astronomically unlikely.
//
// The caller passes a UTC day start (00:00Z); dayFileUlid encodes it verbatim
// (it does not re-floor), keeping it a pure, exact inverse of decodeUlidTime.
export function dayFileUlid(dayStartMs: number): string {
  return encodeCrockfordTime48(dayStartMs) + DAY_FILE_TAIL;
}

// ---- day grouping (pure) ----------------------------------------------------

// dayStartOf — pure: reduces a ULID timestamp (ms since epoch) to the
// start of its UTC day (00:00:00.000Z of that day). This is the
// partition key used to group candidates into day-files.
//
// Rationale (fixed 19/07): we partition by the file's own ULID time,
// not by mtime. Two consequences: (a) the partition is a pure function
// of the basename — no filesystem needed to classify, robust across
// crashes/re-runs; (b) a session that starts at 23:59 and writes past
// midnight lands entirely in the day-file of the day it *started*.
// The rare silence-fallback case (ulid ancient, mtime older-but-not-
// recent) may create a day-file whose basename says "old" but whose
// content is recent; retention's max(ulidTime, mtime) protects it from
// immediate purge, so nothing breaks — cosmetic only.
export function dayStartOf(ulidTimeMs: number): number {
  return Math.floor(ulidTimeMs / DAY_MS) * DAY_MS;
}

// planCompaction — pure: given a set of already-classified candidate
// entries, group them by their UTC day. Input order is preserved
// within each group. Empty input → empty plan.
//
// The caller has already run isCandidateFile on each entry; this
// function does not re-check candidacy. It also assumes each
// ulidTimeMs came from decodeUlidTime(basename) (never null) and
// that no entry is itself a day-file (basename tail !== DAY_FILE_TAIL).
// Both invariants are enforced upstream by the scan.
export function planCompaction(
  entries: readonly CandidateEntry[],
): CompactionPlan {
  const groups = new Map<number, CandidateEntry[]>();
  for (const entry of entries) {
    const day = dayStartOf(entry.ulidTimeMs);
    const bucket = groups.get(day);
    if (bucket !== undefined) {
      bucket.push(entry);
    } else {
      groups.set(day, [entry]);
    }
  }
  return { groups };
}

// ---- candidate classification (pure) ----------------------------------------

// Age past which a file with no terminal event is compacted anyway (kill -9 /
// crash with no proxy.shutdown, proxy.child_exited, or SessionEnd line).
const SILENCE_FALLBACK_MS = 7 * DAY_MS;

// isCandidateFile — PURE: content + mtime + now → boolean. No filesystem, so it
// is unit-testable in isolation. Scans lines with a tolerant per-line parse (a
// malformed line never counts as a terminal marker) for the three terminal
// signals; absent all of them, falls back to the silence rule.
export function isCandidateFile(
  content: string,
  mtimeMs: number,
  nowMs: number,
): boolean {
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerant: an unparseable line is never a terminal marker
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const type = obj['type'];
    // Wrapper terminal — presence anywhere, not order.
    if (type === 'proxy.shutdown' || type === 'proxy.child_exited') return true;
    // Claude Code terminal — a cc.event whose hookEventName is SessionEnd.
    if (type === 'cc.event' && obj['hookEventName'] === 'SessionEnd') return true;
  }
  // No terminal event found → silence fallback.
  return nowMs - mtimeMs > SILENCE_FALLBACK_MS;
}

// ---- scan (filesystem) ------------------------------------------------------

// Strip the .jsonl suffix to get the ULID basename. Mirrors retention.ts's
// private sessionBasename (kept local rather than exported to avoid widening
// retention's surface for a one-liner).
function sessionBasename(name: string): string {
  return name.slice(0, -'.jsonl'.length);
}

// scanCandidates — reads wrappersDir, filters entries via isSessionFile
// (excludes app-events.jsonl and non-.jsonl) and by ULID validity,
// excludes day-files by their reserved tail, then stats + reads each
// surviving file and keeps those that pass isCandidateFile.
//
// Errors per entry are swallowed: readdir ENOENT → empty; per-file
// stat/read failure → skip (vanished/unreadable, same fail-safe as
// collectPurgable in retention.ts).
//
// NOTE (deferred): scanCandidates currently reads content for every
// ULID-valid session file, even ones that would qualify as candidates
// by silence-fallback alone (mtime > 7d) — no need to look for a
// terminal marker in their content. If the F2.2 closing benchmark
// shows this dominates cycle cost at large N, a stat-first / read-
// only-if-mtime-recent variant is straightforward. Not optimized now:
// premature without benchmark evidence.
async function scanCandidates(
  wrappersDir: string,
  nowMs: number,
): Promise<CandidateEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(wrappersDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: CandidateEntry[] = [];
  for (const name of entries) {
    if (!isSessionFile(name)) continue;
    const basename = sessionBasename(name);
    const ulidTimeMs = decodeUlidTime(basename);
    if (ulidTimeMs === null) continue; // fail-safe: non-ULID → skip
    // Exclude day-files by their reserved tail.
    if (basename.slice(10) === DAY_FILE_TAIL) continue;
    const fullPath = join(wrappersDir, name);
    let mtimeMs: number;
    let content: string;
    let freshness: FreshnessToken;
    try {
      const st = await stat(fullPath, { bigint: true });
      freshness = {
        mtimeNs: st.mtimeNs,
        ctimeNs: st.ctimeNs,
        ino: st.ino,
        size: st.size,
      };
      mtimeMs = Number(st.mtimeNs / 1_000_000n);
      content = await readFile(fullPath, 'utf8');
    } catch {
      continue; // vanished / unreadable — skip
    }
    if (!isCandidateFile(content, mtimeMs, nowMs)) continue;
    out.push({ name, content, mtimeMs, ulidTimeMs, freshness });
  }
  // Sort by basename (ULID) → chronological by ULID timestamp.
  // readdir order is filesystem-dependent (POSIX makes no guarantee);
  // sorting here makes the plan deterministic regardless of platform,
  // and lands lines in the day file in chronological order — which is
  // what the reader (assembleAudit → sort by ts desc) already expects
  // as the natural insertion order per file.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---- id-based idempotence (pure) --------------------------------------------

// extractIds — pure: parses JSONL content line by line and returns the
// set of top-level `id` fields found. Tolerant to malformed lines
// (unparseable → skipped), missing id (skipped), non-string id
// (skipped — the envelope schema pins id to string; anything else is
// corruption). Empty content → empty set.
//
// Called on the existing day file at the start of each group's
// processing, to build the "already durable" id set for filtering
// incoming candidates.
export function extractIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerant: malformed line ignored
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const id = obj['id'];
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

// filterExistingIds — pure: given a candidate's content and a set of
// ids already durable in the day file, return { filtered, skipped }.
// Filtered content preserves the input's line separators (each line
// ends with '\n' as JSONL invariant); skipped lines are omitted
// entirely (no trailing newlines for them).
//
// Skipped line = line whose parsed `id` string is in `existing`.
// Malformed lines are ALWAYS kept (better a legible partial than a
// silent drop): the reader will skip them on parse, retention will
// eventually purge, but we do not decide to lose them here.
// Lines without id (shouldn't exist in the trail, but defensive) are
// ALSO kept — we only skip explicit id matches.
export function filterExistingIds(
  content: string,
  existing: Set<string>,
): { filtered: string; skipped: number } {
  if (existing.size === 0) return { filtered: content, skipped: 0 };

  let filtered = '';
  let skipped = 0;
  const parts = content.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    const isLast = i === parts.length - 1;
    if (line === '' && isLast) continue; // trailing '' after final '\n'

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      filtered += line;
      if (!isLast) filtered += '\n';
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      filtered += line;
      if (!isLast) filtered += '\n';
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const id = obj['id'];
    if (typeof id === 'string' && existing.has(id)) {
      skipped++;
      continue; // drop this line entirely
    }
    filtered += line;
    if (!isLast) filtered += '\n';
  }
  return { filtered, skipped };
}

// serializeGroup — pure: joins each candidate's content verbatim.
// Each candidate's content is assumed to end with '\n' already (JSONL
// invariant of the audit trail); we do NOT re-normalize or trim.
// Idempotence (step 3c) will pre-filter this input; step 3b passes
// the group's entries through unchanged.
function serializeGroup(entries: readonly CandidateEntry[]): string {
  let out = '';
  for (const entry of entries) {
    out += entry.content;
  }
  return out;
}

// loadDayFileIds — reads the day file (if it exists) and returns the
// set of ids already durable there. ENOENT → empty set (first
// compaction for this day). Any other read error propagates.
//
// NOTE (deferred): this parses the entire day file every cycle
// (~15s cadence). At the projected steady-state N (600-2000 lines
// in the active day file), JSON.parse cost is ~20ms/cycle — well
// within budget. If the F2.2 closing benchmark shows this dominates
// at higher N, a cross-cycle id cache keyed on day-file mtime is
// straightforward: invalidate when mtime changes, keep the Set
// otherwise. Not optimized now: premature without benchmark evidence,
// and cache invalidation carries its own hazards.
async function loadDayFileIds(dayFilePath: string): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(dayFilePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  return extractIds(content);
}

// fsyncDir — fsync the directory to make dirent changes (create,
// unlink) durable. POSIX requires this after any operation that
// adds or removes an entry in the directory. Called after appends
// that create a new day file AND after the unlink phase. Failures
// propagate: the cycle reports the error via ingestCycle's finally
// → index.ts's .catch.
async function fsyncDir(dirPath: string): Promise<void> {
  const dirFd = await open(dirPath, 'r');
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

// appendVerbatimAndFsync — append raw bytes to a day file with durability
// stronger than a plain writeFile: content fsync via fd.sync(), then a
// separate fsync on the containing directory. POSIX does not guarantee
// dirent durability on file creation just because the file itself is
// fsynced ("durable directory update" pattern — see LevelDB/SQLite
// design docs). Called once per day-file per cycle, not per line, so
// the fsync cost is O(groups).
//
// The 0o600 permission matches the mode used by the wrapper/ingester
// when creating session files, so the compacted day files inherit the
// same permission profile and retention treats them uniformly.
//
// macOS caveat: fd.sync() calls fsync(2), which on macOS does NOT
// guarantee durability against power loss (Apple docs are explicit;
// real durability requires F_FULLFSYNC — SQLite uses it by default on
// Darwin for this reason). We deliberately do NOT use F_FULLFSYNC here
// because (a) it is orders of magnitude slower and this loop runs every
// 15s, and (b) our correctness under power loss is guaranteed by the
// ordering "fsync-before-unlink" plus 3c's id-based idempotence: a
// power loss between append and unlink leaves the sources intact, the
// next cycle re-scans, and step 3c skips ids already durable in the
// day file. Trade-off: in the (extremely rare) power-loss window, we
// pay a re-scan on the next cycle. No data loss.
//
// NOTE for step 3d: a SECOND dir fsync will be required AFTER the
// unlinks of the source files (unlink also changes dirents; POSIX
// requires dir fsync to make the removal durable). That second fsync
// lives in 3d's unlink path, not here.
async function appendVerbatimAndFsync(
  dayFilePath: string,
  wrappersDir: string,
  data: string,
): Promise<void> {
  const fd = await open(dayFilePath, 'a', 0o600);
  try {
    await fd.writeFile(data, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fsyncDir(wrappersDir);
}

// ---- cycle orchestration ----------------------------------------------------

export async function runCompactionCycle(
  wrappersDir: string,
  now: number,
): Promise<CompactionOutcome> {
  // PASO 3d: scan + plan + id-based idempotence + append verbatim to
  // day files with full durability, THEN unlink each source whose
  // 4-leg freshness token is unchanged since scan. A second dir fsync
  // at the end of the cycle makes the unlinks durable.
  //
  // Residual TOCTOU window: between our re-stat and unlink, a
  // concurrent writer could still append to the source and lose those
  // bytes. This window is microseconds and requires a writer that
  // (a) is not the wrapper (a live wrapper has NOT emitted its
  // terminal event, so the file is not a candidate in the first
  // place), and (b) knows the same session ULID basename. In
  // practice the only realistic writer is the CC ingester processing
  // a delayed spool entry for an already-terminal session — a
  // pathological corner. If dogfood or the F2.2 closing benchmark
  // shows any observable loss, the mitigation is rename-based
  // compaction (rename source to a `.compacting` sentinel before
  // reading, unlink at the end). Not implemented now: complexity
  // significant for a corner that may never fire.

  const candidates = await scanCandidates(wrappersDir, now);
  const plan = planCompaction(candidates);

  if (plan.groups.size === 0) {
    return {
      filesCompacted: 0,
      filesSkippedFreshness: 0,
      linesAppended: 0,
      linesSkippedDuplicate: 0,
      dayFilesTouched: [],
    };
  }

  let linesAppended = 0;
  let linesSkippedDuplicate = 0;
  let filesSkippedFreshness = 0;
  let filesCompacted = 0;
  let anyUnlinked = false;
  const dayFilesTouched: string[] = [];

  for (const [dayStart, entries] of plan.groups) {
    const dayBasename = `${dayFileUlid(dayStart)}.jsonl`;
    const dayPath = join(wrappersDir, dayBasename);

    const existingIds = await loadDayFileIds(dayPath);

    let dataToAppend = '';
    for (const entry of entries) {
      const { filtered, skipped } = filterExistingIds(entry.content, existingIds);
      dataToAppend += filtered;
      linesSkippedDuplicate += skipped;
    }

    dayFilesTouched.push(dayBasename);

    if (dataToAppend.length > 0) {
      await appendVerbatimAndFsync(dayPath, wrappersDir, dataToAppend);
      for (let i = 0; i < dataToAppend.length; i++) {
        if (dataToAppend.charCodeAt(i) === 0x0a) linesAppended++;
      }
    }
    // Si todo era duplicado, skip del fsync post-append: nada nuevo
    // que persistir. La idempotencia asegura el mismo day file tras
    // ciclo 1 en adelante.

    // Freshness re-stat con token de 4 patas + unlink condicional.
    // Vanished (stat falla) → skip silencioso: nada que unlink,
    //   ningún contador.
    // Token no coincide (mtime, ctime, ino, o size distintos) →
    //   filesSkippedFreshness++, no unlink.
    // Token coincide → unlink; ENOENT del unlink cuenta como
    //   compacted (trabajo hecho, estado equivalente); otros
    //   errores propagan.
    for (const entry of entries) {
      let currentToken: FreshnessToken;
      try {
        const st = await stat(join(wrappersDir, entry.name), { bigint: true });
        currentToken = {
          mtimeNs: st.mtimeNs,
          ctimeNs: st.ctimeNs,
          ino: st.ino,
          size: st.size,
        };
      } catch {
        continue; // vanished — no counter change (documented in
                  // cabecera; no unit test — scenario needs a
                  // real race, deferred).
      }
      if (!sameFreshness(currentToken, entry.freshness)) {
        filesSkippedFreshness++;
        continue;
      }
      try {
        await unlink(join(wrappersDir, entry.name));
        filesCompacted++;
        anyUnlinked = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Race between our re-stat and unlink: someone else
          // removed it. Equivalent outcome — count as compacted.
          filesCompacted++;
          anyUnlinked = true;
          continue;
        }
        throw err;
      }
    }
  }

  if (anyUnlinked) {
    await fsyncDir(wrappersDir);
  }

  return {
    filesCompacted,
    filesSkippedFreshness,
    linesAppended,
    linesSkippedDuplicate,
    dayFilesTouched,
  };
}
