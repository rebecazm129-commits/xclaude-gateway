// Write engine for a project's .mcp.json — F2.1c part 1. The writer decides
// NOTHING: the caller injects a pure transform (computePlan + applyPlan from
// F2.1b composed over the current on-disk state) and this module only
// persists its output safely: freshness-check → atomic tmp/rename → post-
// write verification → at most ONE re-application if a foreign writer
// interleaved. Never throws; results are values, parser.ts style.
//
// Freshness-check (condition A of the F2.1c re-audit): statSync with
// { bigint: true }, comparing mtimeNs + ctimeNs + ino + size — never float
// mtimeMs (racy-git precedent: two writes inside the same millisecond are an
// invisible conflict in ms resolution; see CcFreshness for why each of the
// four legs earns its place). The re-stat happens as the LAST act
// before writeAtomic. The first stat is taken BEFORE the read on purpose:
// a foreign write landing between stat and read surfaces as a (false)
// conflict and goes through the re-apply round — fail-safe direction —
// instead of being silently clobbered.
//
// RESIDUAL UNDETECTABLE WINDOW (condition B — this is CONTRACT, not a
// footnote): a foreign write landing between our last re-stat and our
// rename is overwritten, and the post-write verification CANNOT see it —
// the re-read finds exactly the bytes we intended, because our rename was
// the last one. Without a lock this window is not eliminable, and Claude
// Code would not honor a lock of ours anyway. Therefore 'converged' means
// "no conflict DETECTED", not "no conflict happened". The stress harness
// (F2.1c part 2) quantifies this window; its invariant is "no undetected
// loss OUTSIDE the residual window", never an absolute "zero loss".
//
// Serialization: the bytes on disk are ALWAYS
//   JSON.stringify(value, null, 2)   — with NO trailing newline —
// which is exactly how Claude Code v2.1.214 writes .mcp.json (spike 3
// fixtures end on the closing brace). serializeMcpJson is the single
// in-module source of that shape, and writeAtomic is called with
// trailingNewline:false so its bytes match it. Round-trip byte-identity
// (F2.1b) and the verification's text comparison BOTH depend on this exact
// form: change one side and verification would report false conflicts.

import { readFileSync, statSync } from 'node:fs';
import { writeAtomic } from '../config/io.js';
import type { WriteAtomicError } from '../config/io.js';
import { readMcpJson } from './parser.js';
import type { CcFileError, CcServerEntry } from './types.js';

// The injected pure step. Receives the successfully-parsed CURRENT state of
// the file and returns the desired new file value. The writer stays
// intent-free: wrap, unwrap or anything else is the caller's composition.
export type CcMcpTransform = (state: {
  servers: Readonly<Record<string, CcServerEntry>>;
  raw: unknown;
}) => unknown;

export type CcWriteError =
  | { kind: 'not-found' }                       // .mcp.json absent: nothing to update
  | { kind: 'read'; error: CcFileError }        // unreadable / invalid-json / unexpected-shape
  | { kind: 'write'; error: WriteAtomicError }; // writeAtomic failure

// Discriminated by `outcome`. `writes` counts OUR writeAtomic calls that
// succeeded (0 = the transform was already satisfied on disk, nothing
// rewritten). 'gave-up' carries the bytes observed on disk at the moment of
// giving up, for the caller/UI to report. Per condition B, 'converged'
// asserts only that no conflict was DETECTED.
//
// CAUTION (contract): observedText is a full .mcp.json snapshot and may
// contain server env secrets. Callers must NOT persist it nor write it to
// the audit trail without passing it through credential masking first.
export type CcWriteResult =
  | { ok: true; outcome: 'converged'; writes: 0 | 1 | 2 }
  | { ok: false; outcome: 'gave-up'; writes: 0 | 1 | 2; observedText: string }
  | { ok: false; outcome: 'error'; error: CcWriteError };

// Freshness token per condition A, hardened (F2.1c re-audit): FOUR legs,
// all bigint straight from statSync({ bigint: true }), a conflict if ANY
// moved. Why four: our own test proves mtime is forgeable from userland
// with utimes(2); size only saves you when the length changes; ino ALWAYS
// changes under atomic rename-writers; and ctime cannot be set from
// userland. Same combination Git's index compares to catch racy changes
// (mtime+ctime+ino+size).
export interface CcFreshness {
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  size: bigint;
}

// null ≡ the file cannot be stat'ed (absent or unreadable) — callers treat
// that as not-found/conflict, never as "fresh".
export function statFreshness(path: string): CcFreshness | null {
  try {
    const st = statSync(path, { bigint: true });
    return { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, size: st.size };
  } catch {
    return null;
  }
}

function sameFreshness(a: CcFreshness, b: CcFreshness): boolean {
  return (
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.ino === b.ino &&
    a.size === b.size
  );
}

// THE byte shape of .mcp.json (see header). Single source in this module.
export function serializeMcpJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// One read → transform → guarded write round, shared by both rounds of
// updateMcpJson. `done` is terminal; `conflict` means the freshness moved
// (before the write) or the verification re-read found foreign bytes (after
// it) — `wrote` tells the caller whether this round's writeAtomic ran, for
// the final `writes` accounting.
type RoundOutcome =
  | { done: CcWriteResult }
  | { conflict: true; wrote: boolean };

function runRound(path: string, transform: CcMcpTransform, priorWrites: 0 | 1): RoundOutcome {
  const fresh1 = statFreshness(path);
  const r = readMcpJson(path);
  if (!r.ok) return { done: { ok: false, outcome: 'error', error: { kind: 'read', error: r.error } } };
  if (!r.present || fresh1 === null) {
    return { done: { ok: false, outcome: 'error', error: { kind: 'not-found' } } };
  }
  const next = transform({ servers: r.servers, raw: r.raw });
  const want = serializeMcpJson(next);
  if (want === serializeMcpJson(r.raw)) {
    // The on-disk state already satisfies the transform (value-level): do
    // not rewrite the file just to normalize formatting.
    return { done: { ok: true, outcome: 'converged', writes: priorWrites } };
  }
  // Freshness-check: LAST act before writeAtomic (condition A).
  const fresh2 = statFreshness(path);
  if (fresh2 === null || !sameFreshness(fresh1, fresh2)) return { conflict: true, wrote: false };
  const w = writeAtomic(path, next, { backup: false, trailingNewline: false });
  if (!w.ok) return { done: { ok: false, outcome: 'error', error: { kind: 'write', error: w.error } } };
  // Post-write verification by re-reading. Seeing `want` does NOT prove no
  // foreign write was clobbered inside the stat→rename window (condition B);
  // it proves no conflict was DETECTED.
  const seen = readText(path);
  if (seen === want) {
    return { done: { ok: true, outcome: 'converged', writes: (priorWrites + 1) as 1 | 2 } };
  }
  return { conflict: true, wrote: true };
}

// Full cycle: read → transform → freshness-check → write → verify, with at
// most ONE re-application round if a foreign writer interleaved, then an
// explicit stop (converged / gave-up with the observed state). Never throws.
export function updateMcpJson(path: string, transform: CcMcpTransform): CcWriteResult {
  const first = runRound(path, transform, 0);
  if ('done' in first) return first.done;
  const priorWrites = first.wrote ? 1 : 0;
  const second = runRound(path, transform, priorWrites as 0 | 1);
  if ('done' in second) return second.done;
  // Second conflict: stop, never a third write (F2.1c dictate).
  const writes = (priorWrites + (second.wrote ? 1 : 0)) as 0 | 1 | 2;
  return { ok: false, outcome: 'gave-up', writes, observedText: readText(path) ?? '' };
}
