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

export interface CompactionOutcome {
  filesCompacted: number; // originals unlinked this cycle
  filesSkippedFreshness: number; // grew during append → not unlinked
  linesAppended: number; // net (after id-dedup against day file)
  linesSkippedDuplicate: number; // ids already present in day file
  dayFilesTouched: readonly string[]; // basenames, for logging
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

// ---- cycle orchestration ----------------------------------------------------

// runCompactionCycle — SKELETON (F2.2 paso 1). The signature and return type are
// final so the ingest-cycle call site can be typed in paso 2 without committing
// to the body. The real implementation lands in a later paso; the TODOs below
// mirror the per-cycle contract in the module header, step for step. Returns an
// empty outcome for now (nothing scanned, nothing compacted).
export async function runCompactionCycle(
  wrappersDir: string,
  now: number,
): Promise<CompactionOutcome> {
  // TODO paso 1 — SCAN: readdir(wrappersDir); for each entry that isSessionFile
  //   (retention.ts) with a valid ULID basename (decodeUlidTime !== null) that
  //   is NOT itself a day file (basename tail !== DAY_FILE_TAIL), stat + read
  //   and keep it iff isCandidateFile(content, mtimeMs, now). Delegate the fs
  //   work to internal helpers (readdir/stat/read).
  // TODO paso 2 — GROUP: bucket candidates by UTC day start
  //   (Math.floor(decodeUlidTime(basename) / DAY_MS) * DAY_MS, mtime as the
  //   fallback for the silence-only case), keyed by dayFileUlid(dayStart) → the
  //   destination day-file basename.
  // TODO paso 3 — APPEND + FRESHNESS: per group, append the surviving source
  //   lines verbatim to the day file (create if missing), fsync, then re-stat
  //   each source and unlink ONLY if its size is unchanged since the pre-append
  //   stat (grew → leave it, count filesSkippedFreshness).
  // TODO paso 4 — IDEMPOTENCE: before appending, load the ids already present in
  //   the day file and skip any source line whose id matches (count
  //   linesSkippedDuplicate). Any residual post-crash duplicate is collapsed by
  //   the reader by id (detection-reader assembleAudit).
  return {
    filesCompacted: 0,
    filesSkippedFreshness: 0,
    linesAppended: 0,
    linesSkippedDuplicate: 0,
    dayFilesTouched: [],
  };
}
