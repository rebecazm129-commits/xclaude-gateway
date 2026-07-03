// Tool-manifest baseline + change detection (tool poisoning, entrega 1).
//
// The proxy sees every tools/list response verbatim. This module keeps a small
// persistent baseline PER CONNECTOR (baseDir/manifests/<mcp>.json) — a global
// hash plus a name→signature map — and, on each tools/list, diffs the live
// manifest against it. First session (or a corrupt/unknown baseline) seeds
// silently (no detection). A real change emits ONE detection and updates the
// baseline, so the same change never alerts twice. Pure functions are exported
// for unit testing; the store owns the (synchronous) file I/O.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from '@xcg/shared/config';
import type { DetectionBlock, DetectionFinding, Severity } from '@xcg/shared';

export const MANIFEST_VERSION = 1;

// ---- pure canonicalization / hashing ----

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Recursively sorts object keys so property order never affects a hash. Arrays
// keep their order (tool arrays are ordered separately, by name).
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ---- manifest model ----

export interface ToolDef {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
}

// Per-tool signature, split so the diff can distinguish a description change
// from a schema change (different finding types; both severity high).
export interface ToolSig {
  d: string; // sha256(description)
  s: string; // sha256(canonicalJson(inputSchema))
}

export interface Manifest {
  hash: string; // sha256 over the whole (name-sorted) map — order-independent
  tools: Record<string, ToolSig>; // name -> sig
}

function toolSig(tool: ToolDef): ToolSig {
  return {
    d: sha256(typeof tool.description === 'string' ? tool.description : ''),
    s: sha256(canonicalJson(tool.inputSchema ?? null)),
  };
}

// Extracts result.tools[] as ToolDef[] (objects with a string name). Anything
// malformed is skipped — the hash reflects what's actually a tool.
export function extractTools(result: unknown): ToolDef[] {
  if (typeof result !== 'object' || result === null) return [];
  const tools = (result as Record<string, unknown>)['tools'];
  if (!Array.isArray(tools)) return [];
  const out: ToolDef[] = [];
  for (const t of tools) {
    if (t !== null && typeof t === 'object') {
      const o = t as Record<string, unknown>;
      if (typeof o['name'] === 'string') {
        out.push({ name: o['name'], description: o['description'], inputSchema: o['inputSchema'] });
      }
    }
  }
  return out;
}

export function buildManifest(tools: readonly ToolDef[]): Manifest {
  const map: Record<string, ToolSig> = {};
  for (const t of tools) map[t.name] = toolSig(t); // last-wins on duplicate names
  const sortedNames = Object.keys(map).sort();
  const canonical = sortedNames.map((n) => [n, map[n]]);
  return { hash: sha256(JSON.stringify(canonical)), tools: map };
}

// ---- diff → findings + severity ----

// null when the manifests are equivalent. Otherwise a DetectionBlock with one
// finding per change (type + tool name in `location`), severity = the highest
// present: description/schema change → high; add/remove → medium.
export function diffManifest(prev: Manifest, next: Manifest): DetectionBlock | null {
  if (prev.hash === next.hash) return null;
  const findings: DetectionFinding[] = [];
  const names = new Set([...Object.keys(prev.tools), ...Object.keys(next.tools)]);
  for (const name of [...names].sort()) {
    const p = prev.tools[name];
    const n = next.tools[name];
    if (p === undefined && n !== undefined) {
      findings.push({ type: 'tool_added', location: name });
    } else if (p !== undefined && n === undefined) {
      findings.push({ type: 'tool_removed', location: name });
    } else if (p !== undefined && n !== undefined) {
      if (p.d !== n.d) findings.push({ type: 'description_changed', location: name });
      if (p.s !== n.s) findings.push({ type: 'schema_changed', location: name });
    }
  }
  if (findings.length === 0) return null;
  const severity: Severity = findings.some(
    (f) => f.type === 'description_changed' || f.type === 'schema_changed',
  )
    ? 'high'
    : 'medium';
  return { category: 'tool_manifest_changed', severity, findings };
}

// ---- persistent baseline store (one file per connector) ----

interface StoredManifest {
  v: number;
  mcp: string;
  hash: string;
  tools: Record<string, ToolSig>;
  updatedAt: string;
}

export interface ManifestOutcome {
  changed: boolean;
  detection?: DetectionBlock;
}

export interface ManifestStore {
  // Compares the connector's live tools/list result against the persisted
  // baseline. First time / corrupt / unknown-version baseline → silent
  // (re)seed, no detection. A real change → updates the baseline and returns
  // the detection exactly once.
  checkAndUpdate(mcp: string, result: unknown): ManifestOutcome;
}

export interface ManifestStoreOptions {
  now?: () => string; // injectable clock for updatedAt (tests); default: wall clock
}

// Filesystem-safe, collision-free per-connector filename: a sanitized mcp for
// readability plus a short hash of the raw mcp for uniqueness.
function manifestFileName(mcp: string): string {
  const safe = mcp.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';
  return `${safe}.${sha256(mcp).slice(0, 12)}.json`;
}

export function createManifestStore(
  baseDir: string,
  opts: ManifestStoreOptions = {},
): ManifestStore {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const dir = join(baseDir, 'manifests');
  const pathFor = (mcp: string): string => join(dir, manifestFileName(mcp));

  function readBaseline(mcp: string): Manifest | null {
    let raw: string;
    try {
      raw = readFileSync(pathFor(mcp), 'utf8');
    } catch {
      return null; // absent
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt → treat as absent (silent reseed)
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj['v'] !== MANIFEST_VERSION) return null; // unknown version → absent
    const hash = obj['hash'];
    const tools = obj['tools'];
    if (typeof hash !== 'string' || typeof tools !== 'object' || tools === null) return null;
    const map: Record<string, ToolSig> = {};
    for (const [k, v] of Object.entries(tools as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) return null;
      const d = (v as Record<string, unknown>)['d'];
      const s = (v as Record<string, unknown>)['s'];
      if (typeof d !== 'string' || typeof s !== 'string') return null;
      map[k] = { d, s };
    }
    return { hash, tools: map };
  }

  function writeBaseline(mcp: string, manifest: Manifest): void {
    const payload: StoredManifest = {
      v: MANIFEST_VERSION,
      mcp,
      hash: manifest.hash,
      tools: manifest.tools,
      updatedAt: now(),
    };
    const path = pathFor(mcp);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(path)) {
        // Cold-start seed: writeAtomic requires an existing target (it backs it
        // up + stats it first), so the first write is a plain write.
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      } else {
        writeAtomic(path, payload);
      }
    } catch (err) {
      // Best-effort: a write failure must never break the proxy hot path. Worst
      // case the baseline lags and the same change re-alerts next time.
      console.error(`manifest store: failed to write ${path}:`, err);
    }
  }

  function checkAndUpdate(mcp: string, result: unknown): ManifestOutcome {
    const next = buildManifest(extractTools(result));
    const prev = readBaseline(mcp);
    if (prev === null) {
      writeBaseline(mcp, next); // silent seed / reseed
      return { changed: false };
    }
    if (prev.hash === next.hash) return { changed: false }; // no change, no rewrite
    const detection = diffManifest(prev, next);
    // Align the baseline to the new manifest either way (never alert twice for
    // the same change). detection is null only in the hash-differs-but-no-diff
    // edge; still reseed silently.
    writeBaseline(mcp, next);
    return detection !== null ? { changed: true, detection } : { changed: false };
  }

  return { checkAndUpdate };
}
