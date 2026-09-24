// The v2 baseline file: a canonical SNAPSHOT per section plus two hashes over
// it, written next to the v1 file and never on top of it.
//
// WHY A SNAPSHOT AND NOT ONLY HASHES. v1 stores hashes, which makes every
// question except "did this change?" unanswerable. Changing which fields count
// as security-relevant would mean reseeding — throwing away the baseline and
// going blind for one observation. With the snapshot on disk the projection can
// be recomputed from what was already seen, so a change of OUR OWN rules is
// never mistaken for a change of THEIR manifest.
//
// THREE INDEPENDENT VERSIONS, because they invalidate different things:
//   storage_version              - the shape of this file. Invalidates nothing.
//   canonicalization_version     - how bytes are produced. Invalidates both hashes.
//   security_projection_version  - which fields are security-relevant.
//                                  Invalidates security_hash only.
// Collapsing them would force a reseed for a cosmetic change.
//
// WHY A SEPARATE PATH. v2 keeps writing the v1 file, in the v1 path, with the
// frozen v1 algorithm, for a compatibility window of at least two published
// versions (ended only by an explicit decision). An installation still on v1
// reads that file and must find exactly what it expects, so the v1 path is
// never overwritten with v2 content.

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const STORAGE_VERSION = 2;
export const CANONICALIZATION_VERSION = 1;
export const SECURITY_PROJECTION_VERSION = 1;

/** Sections of a connector's advertised surface. `discovery` holds
 *  server/discover's result (supportedVersions, capabilities, instructions) —
 *  NOT tools: server/discover does not return a tool list. */
export const SECTIONS = [
  'discovery',
  'tools',
  'resources',
  'resource_templates',
  'prompts',
] as const;
export type SectionName = (typeof SECTIONS)[number];

/** How many recent wire hashes to remember per section, so a return to a state
 *  already seen can be REPORTED. It never suppresses severity: A→B→A is a
 *  perfectly good way to hide a change in plain sight. */
export const RECENT_WIRE_HASHES = 10;

export interface SectionState {
  /** `incomplete` means a snapshot could not be assembled (pagination failed,
   *  a cursor repeated, a page cap was hit). The baseline is NOT advanced in
   *  that state — a partial list would read as a change that never happened. */
  state: 'current' | 'incomplete';
  wire_hash: string;
  security_hash: string;
  /** The canonical snapshot the hashes were computed from. */
  snapshot: unknown;
  pages: number;
  initialized_at: string;
  last_changed_generation: number;
  /** Most recent first, this section's current hash included. */
  recent_wire_hashes: string[];
}

export interface BaselineV2 {
  storage_version: number;
  canonicalization_version: number;
  security_projection_version: number;
  mcp: string;
  writer_app_version: string;
  /** Monotonic, +1 on every write of this file. */
  generation: number;
  updated_at: string;
  sections: Partial<Record<SectionName, SectionState>>;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** v2 lives in its own directory so the v1 path is never shadowed. */
export function v2Dir(baseDir: string): string {
  return join(baseDir, 'manifests', 'v2');
}

export function v2PathFor(baseDir: string, mcp: string): string {
  const safe = mcp.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';
  return join(v2Dir(baseDir), `${safe}.${sha256(mcp).slice(0, 12)}.json`);
}

export function emptyBaseline(mcp: string, appVersion: string, now: string): BaselineV2 {
  return {
    storage_version: STORAGE_VERSION,
    canonicalization_version: CANONICALIZATION_VERSION,
    security_projection_version: SECURITY_PROJECTION_VERSION,
    mcp,
    writer_app_version: appVersion,
    generation: 0,
    updated_at: now,
    sections: {},
  };
}

/** Pushes a hash onto the recent list, most recent first, deduped, capped. */
export function pushRecent(recent: readonly string[], hash: string): string[] {
  return [hash, ...recent.filter((h) => h !== hash)].slice(0, RECENT_WIRE_HASHES);
}

export type ReadOutcome =
  | { kind: 'ok'; baseline: BaselineV2 }
  | { kind: 'absent' }
  /** The auditor's own state could not be read. Reported as an integrity
   *  warning, never as a manifest change. */
  | { kind: 'corrupt'; detail: string };

function isSectionState(v: unknown): v is SectionState {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o['state'] === 'current' || o['state'] === 'incomplete') &&
    typeof o['wire_hash'] === 'string' &&
    typeof o['security_hash'] === 'string' &&
    Array.isArray(o['recent_wire_hashes'])
  );
}

export function readBaselineV2(baseDir: string, mcp: string): ReadOutcome {
  const path = v2PathFor(baseDir, mcp);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'corrupt', detail: `unparseable: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'corrupt', detail: 'not an object' };
  }
  const o = parsed as Record<string, unknown>;
  if (o['storage_version'] !== STORAGE_VERSION) {
    // A FUTURE storage version is not corruption — it is a downgrade. Treat it
    // as absent so this build seeds its own file rather than mangling one it
    // does not understand.
    return { kind: 'absent' };
  }
  if (typeof o['mcp'] !== 'string' || typeof o['generation'] !== 'number') {
    return { kind: 'corrupt', detail: 'missing mcp or generation' };
  }
  const sectionsRaw = o['sections'];
  const sections: Partial<Record<SectionName, SectionState>> = {};
  if (sectionsRaw !== null && typeof sectionsRaw === 'object' && !Array.isArray(sectionsRaw)) {
    for (const [k, v] of Object.entries(sectionsRaw as Record<string, unknown>)) {
      if (!(SECTIONS as readonly string[]).includes(k)) continue;
      // One malformed section degrades to "not tracked yet" — it must never
      // condemn the whole file, which would lose the other sections' history.
      if (isSectionState(v)) sections[k as SectionName] = v;
    }
  }
  return {
    kind: 'ok',
    baseline: {
      storage_version: STORAGE_VERSION,
      canonicalization_version:
        typeof o['canonicalization_version'] === 'number' ? o['canonicalization_version'] : 0,
      security_projection_version:
        typeof o['security_projection_version'] === 'number' ? o['security_projection_version'] : 0,
      mcp: o['mcp'],
      writer_app_version:
        typeof o['writer_app_version'] === 'string' ? o['writer_app_version'] : 'unknown',
      generation: o['generation'],
      updated_at: typeof o['updated_at'] === 'string' ? o['updated_at'] : '',
      sections,
    },
  };
}

export interface WriteResult {
  ok: boolean;
  generation: number;
  error?: string;
}

/**
 * Atomic write: temp file in the SAME directory, fsync, rename. A rename
 * within a directory is atomic, so a reader sees either the old file or the
 * new one and never a half-written baseline. The previous generation is kept
 * as `.prev` — one step back is enough to answer "what did it look like before
 * this write?" without turning the baseline into a second copy of the trail.
 *
 * Never throws: a baseline that cannot be written must not break the proxy hot
 * path. The worst case is that the same change is reported again next time.
 */
export function writeBaselineV2(
  baseDir: string,
  baseline: BaselineV2,
  now: string,
): WriteResult {
  const path = v2PathFor(baseDir, baseline.mcp);
  const next: BaselineV2 = { ...baseline, generation: baseline.generation + 1, updated_at: now };
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(v2Dir(baseDir), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        copyFileSync(path, `${path}.prev`);
      } catch {
        // A missing .prev is a lost convenience, not a lost baseline.
      }
    }
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return { ok: true, generation: next.generation };
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Orphan temp file: harmless, and cleaned by the next successful write.
    }
    return { ok: false, generation: baseline.generation, error: (err as Error).message };
  }
}

/** Seeds the file on a cold start. Split from writeBaselineV2 so the caller
 *  can tell "created" from "updated" without stat-ing. */
export function seedBaselineV2(
  baseDir: string,
  mcp: string,
  appVersion: string,
  now: string,
): WriteResult {
  const path = v2PathFor(baseDir, mcp);
  try {
    mkdirSync(v2Dir(baseDir), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      const seeded = { ...emptyBaseline(mcp, appVersion, now), generation: 1 };
      writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
      return { ok: true, generation: 1 };
    }
    return { ok: true, generation: 0 };
  } catch (err) {
    return { ok: false, generation: 0, error: (err as Error).message };
  }
}
