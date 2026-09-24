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

import { injectionFindings } from './detectors/prompt-injection.js';
import { isSensitiveParamName } from './detectors/sensitive-params.js';
import { hasHiddenCharacters } from './detectors/text-normalize.js';
import { externalRefs, sensitivePathHits, walkSurface } from './detectors/surface-scan.js';

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

// Schema SURFACE of a tool: every property name declared under any nested
// `properties` object of the inputSchema plus every `required` entry, each
// sorted + deduped. Type/description/constraint edits inside the schema leave
// the shape unchanged — only a NEW name (a new way for data to flow into the
// tool) grows it. Recursive on purpose: a parameter smuggled in via anyOf or
// a nested object is surface too.
export interface ToolShape {
  p: string[]; // property names, sorted
  r: string[]; // required entries, sorted
}

// Per-tool signature, split so the diff can distinguish a description change
// from a schema change. `sh` carries the schema surface, which is what tells
// a growing tool from a re-typed one. It is optional only because baselines
// predating it exist; a sig without `sh` simply yields no surface evidence
// (addedSurface returns nothing), so its schema change grades as
// schema_changed — never as an invented high.
export interface ToolSig {
  d: string; // sha256(description)
  s: string; // sha256(canonicalJson(inputSchema))
  sh?: ToolShape;
}

export interface Manifest {
  hash: string; // sha256 over the name-sorted {d,s} map — order-independent,
  //              and deliberately EXCLUDING sh so pre-shape baselines keep
  //              their hash (no spurious change on upgrade, no reseed).
  tools: Record<string, ToolSig>; // name -> sig
}

function collectShape(node: unknown, props: Set<string>, req: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectShape(v, props, req);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const p = o['properties'];
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    for (const name of Object.keys(p)) props.add(name);
  }
  const r = o['required'];
  if (Array.isArray(r)) {
    for (const x of r) if (typeof x === 'string') req.add(x);
  }
  for (const v of Object.values(o)) collectShape(v, props, req);
}

export function toolShape(tool: ToolDef): ToolShape {
  const props = new Set<string>();
  const req = new Set<string>();
  collectShape(tool.inputSchema ?? null, props, req);
  return { p: [...props].sort(), r: [...req].sort() };
}

function toolSig(tool: ToolDef): ToolSig {
  return {
    d: sha256(typeof tool.description === 'string' ? tool.description : ''),
    s: sha256(canonicalJson(tool.inputSchema ?? null)),
    sh: toolShape(tool),
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
  // Hash input is {d,s} only (key order matters for JSON.stringify): byte-for-
  // byte identical to the pre-shape serialization, so existing baselines'
  // hashes stay comparable across the upgrade.
  const canonical = sortedNames.map((n) => [n, { d: map[n]!.d, s: map[n]!.s }]);
  return { hash: sha256(JSON.stringify(canonical)), tools: map };
}

// Full-surface scan of one tool definition. Returns the findings it produces
// and whether any of them justifies high.
//
// Replaces the single-string scan that read only `description`: the 24/09 probe
// showed an instruction in inputSchema.properties.<p>.description, in a vendor
// field, or in a default came out as a bare schema_changed. The walker is
// schema-agnostic on purpose (see surface-scan.ts).
function scanToolSurface(tool: ToolDef, name: string): { findings: DetectionFinding[]; high: boolean } {
  const entries = walkSurface(tool);
  const findings: DetectionFinding[] = [];
  let high = false;

  // Injection markers anywhere on the surface, matched on the normalized view.
  const injectionPaths = entries
    .filter((e) => injectionFindings(e.normalized).length > 0)
    .map((e) => e.path);
  for (const path of injectionPaths.slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({ type: 'injection_marker', location: name, path, rule: 'injection_pattern' });
    high = true;
  }

  // Path-shaped references to credential files. The rule id says WHICH shape
  // matched and the path says WHERE, so the finding explains itself.
  for (const hit of sensitivePathHits(entries).slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({
      type: 'sensitive_path_reference',
      location: name,
      path: hit.path,
      rule: hit.rule,
    });
    high = true;
  }

  // Evidence only: hidden characters and external refs never raise severity on
  // their own. An external $ref is RECORDED and never resolved.
  for (const e of entries) {
    if (e.kind === 'value' && hasHiddenCharacters(e.raw)) {
      findings.push({ type: 'hidden_characters', location: name, path: e.path });
      break;
    }
  }
  for (const ref of externalRefs(entries).slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({ type: 'external_ref', location: name, path: ref.path, rule: 'not_resolved' });
  }
  return { findings, high };
}

// A poisoned manifest can carry an unbounded number of matches; the findings
// list is evidence, not an inventory.
const MAX_SURFACE_FINDINGS = 10;

// Every property/required name a tool declares, at any nesting depth.
function surfaceOf(tool: ToolDef): string[] {
  const sh = toolShape(tool);
  return [...new Set([...sh.p, ...sh.r])];
}

// Property/required names present in `next` and absent from `prev`. An absent
// shape on either side yields nothing: without both shapes there is no
// evidence of GROWTH, and guessing would manufacture severity.
function addedSurface(prev: ToolShape | undefined, next: ToolShape | undefined): string[] {
  if (prev === undefined || next === undefined) return [];
  const out = new Set<string>();
  for (const x of next.p) if (!prev.p.includes(x)) out.add(x);
  for (const x of next.r) if (!prev.r.includes(x)) out.add(x);
  return [...out];
}

// Informational scans over a changed description (see diffManifest).
const EXTERNAL_URL = /https?:\/\/[^\s"'<>)\]]+/i;
const IMPERATIVE =
  /\b(?:you\s+must\s+(?:always|never)|always\s+(?:call|use|send|include)|never\s+(?:tell|reveal|mention|disclose)|do\s+not\s+(?:tell|reveal|mention|inform)|before\s+(?:calling|using)\s+any\s+other)\b/i;

// ---- diff → findings + severity ----

// null when the manifests are equivalent. Otherwise a DetectionBlock with one
// finding per change (type + tool name in `location`).
//
// Grading by STRUCTURE, not by volume (replay over 06-09/2026, 212 manifest
// transitions). The previous rule graded every surface_added as high, which
// made 39% of all alerts high and meant "high" only ever said "a vendor added
// a parameter" — 50 times in two months. What actually distinguishes a
// dangerous addition is WHAT the parameter is: of 123 surface additions in
// the corpus, 7 introduced a parameter whose name is a destination, a
// recipient or a credential (bcc_emails, source_url, file_upload, …).
//   high   → surface_added whose new property/required name is sensitive
//            (sensitive-params.ts, whole-word match), or injection_marker
//            (the NEW description matches the prompt-injection patterns —
//            reused scan, not a second classifier).
//   medium → every other surface_added, plus description_changed /
//            schema_changed on an existing tool (doc and typing edits).
//   low    → tool_added / tool_removed on their own. A manifest that only
//            grows or shrinks is a release, not an attack — unless the NEW
//            tool already declares a sensitive parameter, which is the same
//            question surface_added asks, so it grades high too.
// external_url / imperative_language are INFORMATIONAL findings only: on the
// 4-month corpus every one of them was documentation prose (example.com,
// notion.so page ids, usage guidance), so they never raise severity.
//
// `nextTools` carries the live (raw) tool defs so the injection scan and the
// informational scans can read the NEW description in the clear — the
// baseline only ever stores hashes.
export function diffManifest(
  prev: Manifest,
  next: Manifest,
  nextTools?: readonly ToolDef[],
): DetectionBlock | null {
  if (prev.hash === next.hash) return null;
  const descByName = new Map<string, string>();
  const defByName = new Map<string, ToolDef>();
  if (nextTools !== undefined) {
    for (const t of nextTools) {
      if (typeof t.description === 'string') descByName.set(t.name, t.description);
      defByName.set(t.name, t);
    }
  }
  const findings: DetectionFinding[] = [];
  let high = false;
  let medium = false;
  const names = new Set([...Object.keys(prev.tools), ...Object.keys(next.tools)]);
  for (const name of [...names].sort()) {
    const p = prev.tools[name];
    const n = next.tools[name];
    if (p === undefined && n !== undefined) {
      findings.push({ type: 'tool_added', location: name });
      // A brand-new tool is judged by the same rule as a grown one: what it
      // can RECEIVE. Without the live def (nextTools absent) there is no
      // schema to read, so it stays low rather than guessing.
      const def = defByName.get(name);
      const sensitive =
        def === undefined ? [] : surfaceOf(def).filter(isSensitiveParamName).sort();
      for (const s of sensitive) {
        findings.push({ type: 'sensitive_param_added', location: `${name}.${s}` });
      }
      if (sensitive.length > 0) high = true;
      // A new tool has no history to diff, so its whole surface is scanned.
      // Low by default; high on a sensitive parameter, an injection marker or
      // a path-shaped credential reference.
      if (def !== undefined) {
        const scan = scanToolSurface(def, name);
        findings.push(...scan.findings);
        if (scan.high) high = true;
      }
    } else if (p !== undefined && n === undefined) {
      findings.push({ type: 'tool_removed', location: name });
    } else if (p !== undefined && n !== undefined) {
      const desc = descByName.get(name) ?? '';
      if (p.d !== n.d) {
        findings.push({ type: 'description_changed', location: name });
        medium = true;
        // Informational only. The baseline stores hashes, not text, so these
        // say "present in the NEW description", never "newly introduced".
        // Both were pure documentation prose across the whole corpus.
        if (EXTERNAL_URL.test(desc)) findings.push({ type: 'external_url', location: name });
        if (IMPERATIVE.test(desc)) findings.push({ type: 'imperative_language', location: name });
      }
      if (p.s !== n.s) {
        const added = addedSurface(p.sh, n.sh);
        if (added.length > 0) {
          findings.push({ type: 'surface_added', location: name });
          medium = true;
          const sensitive = added.filter(isSensitiveParamName);
          if (sensitive.length > 0) {
            // location carries the parameter, not the tool: it IS the finding.
            for (const s of sensitive.sort()) {
              findings.push({ type: 'sensitive_param_added', location: `${name}.${s}` });
            }
            high = true;
          }
        } else {
          findings.push({ type: 'schema_changed', location: name });
          medium = true;
        }
      }
      // Anything changed on this tool → scan its whole new surface, not just
      // the description. A schema-only edit can carry the instruction.
      const def = defByName.get(name);
      if (def !== undefined && (p.d !== n.d || p.s !== n.s)) {
        const scan = scanToolSurface(def, name);
        findings.push(...scan.findings);
        if (scan.high) high = true;
      }
    }
  }
  if (findings.length === 0) return null;
  const severity: Severity = high ? 'high' : medium ? 'medium' : 'low';
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
      // sh is optional (pre-shape baselines lack it) and validated leniently:
      // a malformed sh degrades to "no shape" for that tool, which means no
      // surface evidence — never a whole-baseline reseed.
      const shRaw = (v as Record<string, unknown>)['sh'];
      let sh: ToolShape | undefined;
      if (shRaw !== null && typeof shRaw === 'object' && !Array.isArray(shRaw)) {
        const p = (shRaw as Record<string, unknown>)['p'];
        const r = (shRaw as Record<string, unknown>)['r'];
        if (
          Array.isArray(p) && p.every((x): x is string => typeof x === 'string') &&
          Array.isArray(r) && r.every((x): x is string => typeof x === 'string')
        ) {
          sh = { p, r };
        }
      }
      map[k] = sh !== undefined ? { d, s, sh } : { d, s };
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
        // Cold-start seed: writeAtomic requires an existing target (it stats
        // it first), so the first write is a plain write.
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      } else {
        // backup: false — no .bak for baselines. The real "before" of a
        // baseline lives in the trail's raw tools/list responses; a
        // first-write-wins .bak froze the seed-time manifest forever and, in
        // the 11/07 investigation, mixed changes from different dates into
        // one misleading diff. Existing .bak files in old installs are inert.
        writeAtomic(path, payload, { backup: false });
      }
    } catch (err) {
      // Best-effort: a write failure must never break the proxy hot path. Worst
      // case the baseline lags and the same change re-alerts next time.
      console.error(`manifest store: failed to write ${path}:`, err);
    }
  }

  function checkAndUpdate(mcp: string, result: unknown): ManifestOutcome {
    const tools = extractTools(result);
    const next = buildManifest(tools);
    const prev = readBaseline(mcp);
    if (prev === null) {
      writeBaseline(mcp, next); // silent seed / reseed
      return { changed: false };
    }
    if (prev.hash === next.hash) return { changed: false }; // no change, no rewrite
    const detection = diffManifest(prev, next, tools);
    // Align the baseline to the new manifest either way (never alert twice for
    // the same change). detection is null only in the hash-differs-but-no-diff
    // edge; still reseed silently.
    writeBaseline(mcp, next);
    return detection !== null ? { changed: true, detection } : { changed: false };
  }

  return { checkAndUpdate };
}
