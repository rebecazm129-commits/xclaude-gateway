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
import type {
  ChangeKind,
  ConnectorChangeEntry,
  ConnectorFinding,
  DetectionBlock,
  DetectionFinding,
  Severity,
  SnapshotRef,
} from '@xcg/shared';

import { injectionFindings } from './detectors/prompt-injection.js';
import { isSensitiveParamName } from './detectors/sensitive-params.js';
import {
  HIDDEN_CLASS_SEVERITY,
  hiddenCharacterHits,
  type HiddenClass,
} from './detectors/text-normalize.js';
import { ruleStamp } from './rules.js';
import { externalRefs, sensitivePathHits, walkSurface } from './detectors/surface-scan.js';

export const MANIFEST_VERSION = 1;

// ---- pure canonicalization / hashing ----

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Recursively sorts object keys so property order never affects a hash. Arrays
// keep their order: inside a schema an array IS ordered data (an `enum`, an
// `anyOf` branch list), and reordering one changes the contract.
//
// The COLLECTION a section arrives in is the exception and is handled by
// canonicalizeCollection below, not here.
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

// ---- collection canonicalization ----

/** Identity of an item inside a section collection. `name` for tools and
 *  prompts, `uri`/`uriTemplate` for resources and templates. Falls back to the
 *  canonical form of the item itself so an item with no identity still has a
 *  stable position instead of drifting with arrival order. */
export function itemIdentity(item: unknown): string {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return canonicalJson(item);
  }
  const o = item as Record<string, unknown>;
  for (const key of ['name', 'uri', 'uriTemplate']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return `${key}:${v}`;
  }
  return canonicalJson(item);
}

/**
 * Canonical form of a SECTION collection (result.tools, result.resources,
 * result.prompts…). Two things happen here that canonicalize() must never do
 * to an arbitrary array:
 *
 *   - items are ordered by identity, because the order a server lists its
 *     tools in is not part of the contract. A vendor reshuffling its list, or
 *     a paginated section whose pages arrive in a different order, is not a
 *     change and must not hash differently;
 *   - each item is canonicalized normally, so the arrays INSIDE it (enum,
 *     anyOf, required) keep their order, which is contract.
 *
 * Duplicate identities are kept, both of them, sorted: dropping one would
 * silently hide a manifest that ships the same tool name twice.
 */
export function canonicalizeCollection(items: readonly unknown[]): unknown[] {
  return items
    .map((item) => ({ id: itemIdentity(item), value: canonicalize(item) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => x.value);
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
function scanToolSurface(
  tool: ToolDef,
  name: string,
): { findings: DetectionFinding[]; high: boolean; medium: boolean } {
  const entries = walkSurface(tool);
  const findings: DetectionFinding[] = [];
  let high = false;
  let medium = false;

  // Injection markers anywhere on the surface, matched on the normalized view.
  const injectionPaths = entries
    .filter((e) => injectionFindings(e.normalized).length > 0)
    .map((e) => e.path);
  for (const path of injectionPaths.slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({
      type: 'injection_marker',
      ...ruleStamp('injection_marker'),
      location: name,
      path,
      rule: 'injection_pattern',
    });
    high = true;
  }

  // Path-shaped references to credential files. The rule id says WHICH shape
  // matched and the path says WHERE, so the finding explains itself.
  for (const hit of sensitivePathHits(entries).slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({
      type: 'sensitive_path_reference',
      ...ruleStamp('sensitive_path_reference'),
      location: name,
      path: hit.path,
      rule: hit.rule,
    });
    high = true;
  }

  // Invisible characters, graded by class (text-normalize.ts explains why):
  // tag characters, bidi controls and runs of variation selectors are high on
  // their own; zero-width, ANSI and rare invisible controls are medium. The
  // finding names the class, the codepoint and how many, so the reader can tell
  // a stray joiner from a payload. The grading reads HIDDEN_CLASS_SEVERITY, so
  // a class added there needs no change here or in severityOf below.
  let hidden = 0;
  for (const e of entries) {
    if (hidden >= MAX_SURFACE_FINDINGS) break;
    for (const hit of hiddenCharacterHits(e.raw)) {
      findings.push({
        type: 'hidden_characters',
        ...ruleStamp('hidden_characters'),
        location: name,
        path: e.path,
        rule: hit.cls,
        codepoint: hit.codepoint,
        count: hit.count,
      });
      hidden += 1;
      if (HIDDEN_CLASS_SEVERITY[hit.cls] === 'high') high = true;
      else medium = true;
    }
  }

  // Evidence only: an external $ref is RECORDED, never resolved, and never
  // raises severity on its own.
  for (const ref of externalRefs(entries).slice(0, MAX_SURFACE_FINDINGS)) {
    findings.push({ type: 'external_ref', location: name, path: ref.path, rule: 'not_resolved' });
  }
  return { findings, high, medium };
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
// --- the split: what MOVED vs what a RULE made of it ------------------------
//
// These two are kept apart because they answer different questions and the
// facts model (shared/connector-change.ts) reports them separately: changes
// are statements about the connector, findings are judgements by a versioned
// security rule. diffManifest below is now only the merge of the two, kept so
// the existing tool_manifest_changed output stays byte-identical.
//
// ORDER IS PART OF THE CONTRACT. Per tool, facts come first and rules after —
// which is exactly the order the single function used to produce, because
// sensitive_param_added always followed surface_added, and surface_added and
// schema_changed are mutually exclusive.

/** One tool's delta between two manifests. Unchanged tools produce none. */
export type ToolDelta =
  | { kind: 'added'; name: string; def?: ToolDef }
  | { kind: 'removed'; name: string }
  | {
      kind: 'changed';
      name: string;
      prev: ToolSig;
      next: ToolSig;
      def?: ToolDef;
      /** The NEW description in the clear; the baseline only stores hashes. */
      desc: string;
    };

/** Every tool that moved, in stable name order. */
export function toolDeltas(
  prev: Manifest,
  next: Manifest,
  nextTools?: readonly ToolDef[],
): ToolDelta[] {
  const descByName = new Map<string, string>();
  const defByName = new Map<string, ToolDef>();
  if (nextTools !== undefined) {
    for (const t of nextTools) {
      if (typeof t.description === 'string') descByName.set(t.name, t.description);
      defByName.set(t.name, t);
    }
  }
  const deltas: ToolDelta[] = [];
  const names = new Set([...Object.keys(prev.tools), ...Object.keys(next.tools)]);
  for (const name of [...names].sort()) {
    const p = prev.tools[name];
    const n = next.tools[name];
    const def = defByName.get(name);
    if (p === undefined && n !== undefined) {
      deltas.push({ kind: 'added', name, ...(def !== undefined ? { def } : {}) });
    } else if (p !== undefined && n === undefined) {
      deltas.push({ kind: 'removed', name });
    } else if (p !== undefined && n !== undefined && (p.d !== n.d || p.s !== n.s)) {
      deltas.push({
        kind: 'changed',
        name,
        prev: p,
        next: n,
        ...(def !== undefined ? { def } : {}),
        desc: descByName.get(name) ?? '',
      });
    }
  }
  return deltas;
}

export interface ChangeScanResult {
  findings: DetectionFinding[];
  medium: boolean;
}

/**
 * What MOVED on one tool. Facts and informational annotations only — never a
 * security judgement, so this can never raise severity above medium.
 */
export function describeChanges(delta: ToolDelta): ChangeScanResult {
  const findings: DetectionFinding[] = [];
  let medium = false;
  if (delta.kind === 'added') {
    findings.push({ type: 'tool_added', location: delta.name });
  } else if (delta.kind === 'removed') {
    findings.push({ type: 'tool_removed', location: delta.name });
  } else {
    if (delta.prev.d !== delta.next.d) {
      findings.push({ type: 'description_changed', location: delta.name });
      medium = true;
      // Informational only. The baseline stores hashes, not text, so these say
      // "present in the NEW description", never "newly introduced". Both were
      // pure documentation prose across the whole corpus.
      if (EXTERNAL_URL.test(delta.desc)) {
        findings.push({ type: 'external_url', location: delta.name });
      }
      if (IMPERATIVE.test(delta.desc)) {
        findings.push({ type: 'imperative_language', location: delta.name });
      }
    }
    if (delta.prev.s !== delta.next.s) {
      if (addedSurface(delta.prev.sh, delta.next.sh).length > 0) {
        findings.push({ type: 'surface_added', location: delta.name });
      } else {
        findings.push({ type: 'schema_changed', location: delta.name });
      }
      medium = true;
    }
  }
  return { findings, medium };
}

export interface RuleScanResult {
  findings: DetectionFinding[];
  high: boolean;
  medium: boolean;
}

/**
 * What a SECURITY rule makes of one tool's delta.
 *
 * A brand-new tool is judged by the same question as a grown one: what it can
 * RECEIVE. Without the live def there is no schema to read, so it says nothing
 * rather than guessing.
 */
export function scanRules(delta: ToolDelta): RuleScanResult {
  const findings: DetectionFinding[] = [];
  let high = false;
  let medium = false;

  if (delta.kind === 'removed') return { findings, high, medium };

  const sensitive =
    delta.kind === 'added'
      ? delta.def === undefined
        ? []
        : surfaceOf(delta.def).filter(isSensitiveParamName).sort()
      : addedSurface(delta.prev.sh, delta.next.sh).filter(isSensitiveParamName).sort();
  for (const s of sensitive) {
    // location carries the parameter, not the tool: it IS the finding.
    findings.push({
      type: 'sensitive_param_added',
      ...ruleStamp('sensitive_param_added'),
      location: `${delta.name}.${s}`,
    });
  }
  if (sensitive.length > 0) high = true;

  // Anything moved on this tool → scan its whole NEW surface, not just the
  // description. A schema-only edit can carry the instruction.
  if (delta.def !== undefined) {
    const scan = scanToolSurface(delta.def, delta.name);
    findings.push(...scan.findings);
    if (scan.high) high = true;
    if (scan.medium) medium = true;
  }
  return { findings, high, medium };
}

// --- the facts model view --------------------------------------------------
//
// Same walk as diffManifest, but reported the way the product now reads it:
// `changes` says what moved and carries no severity, `findings` says what a
// versioned rule made of it. The informational annotations (external_url,
// imperative_language, external_ref) are not emitted at all — they never
// raised severity, and four months of production showed every one of them to
// be documentation prose.

/** Old finding type -> the section-neutral change vocabulary. */
const CHANGE_KIND: Readonly<Record<string, ChangeKind>> = {
  tool_added: 'item_added',
  tool_removed: 'item_removed',
  description_changed: 'description_changed',
  surface_added: 'surface_added',
  schema_changed: 'schema_changed',
};

/** Severity each rule asserts. Lives with the rule, not with the event: an
 *  event has no severity in this model. */
function severityOf(f: DetectionFinding): ConnectorFinding['severity'] {
  if (f.rule_id === 'hidden_characters') {
    const cls = f.rule as HiddenClass | undefined;
    if (cls === undefined) return 'high'; // unnamed class: assume the worse
    return HIDDEN_CLASS_SEVERITY[cls] === 'high' ? 'high' : 'medium';
  }
  return 'high';
}

export interface ChangeReport {
  changes: ConnectorChangeEntry[];
  findings: ConnectorFinding[];
}

/** What moved and what a rule made of it, for one section's delta. */
export function reportChanges(
  prev: Manifest,
  next: Manifest,
  nextTools?: readonly ToolDef[],
): ChangeReport | null {
  if (prev.hash === next.hash) return null;
  const changes: ConnectorChangeEntry[] = [];
  const findings: ConnectorFinding[] = [];
  for (const delta of toolDeltas(prev, next, nextTools)) {
    for (const f of describeChanges(delta).findings) {
      const kind = CHANGE_KIND[f.type];
      if (kind === undefined) continue; // informational: not a fact about the surface
      changes.push({
        kind,
        target: f.location ?? delta.name,
        ...(f.path !== undefined ? { path: f.path } : {}),
      });
    }
    for (const f of scanRules(delta).findings) {
      if (f.rule_id === undefined) continue; // external_ref: evidence, not a verdict
      const evidence: ConnectorFinding['evidence'] = {};
      if (f.rule_id === 'sensitive_param_added' && f.location !== undefined) {
        evidence.target = delta.name;
        evidence.path = f.location;
      } else if (f.location !== undefined) {
        evidence.target = f.location;
      }
      if (f.path !== undefined) evidence.path = f.path;
      if (f.rule !== undefined) evidence.rule = f.rule;
      if (f.codepoint !== undefined) evidence.codepoint = f.codepoint;
      if (f.count !== undefined) evidence.count = f.count;
      findings.push({
        rule_id: f.rule_id,
        rule_version: f.rule_version ?? 1,
        severity: severityOf(f),
        evidence,
      });
    }
  }
  if (changes.length === 0 && findings.length === 0) return null;
  return { changes, findings };
}

export function diffManifest(
  prev: Manifest,
  next: Manifest,
  nextTools?: readonly ToolDef[],
): DetectionBlock | null {
  if (prev.hash === next.hash) return null;
  const findings: DetectionFinding[] = [];
  let high = false;
  let medium = false;
  for (const delta of toolDeltas(prev, next, nextTools)) {
    const changed = describeChanges(delta);
    findings.push(...changed.findings);
    if (changed.medium) medium = true;
    const ruled = scanRules(delta);
    findings.push(...ruled.findings);
    if (ruled.high) high = true;
    if (ruled.medium) medium = true;
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
  /** The facts-model payload. Present only when something moved. A report with
   *  an empty `findings` is the normal case and is NOT a detection. */
  change?: ChangeReport & { snapshot: SnapshotRef; catalog: { before: number; after: number } };
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

/** The v1 baseline file for one connector. Exposed so the v2 path can keep the
 *  old file alive during the two-published-version window without duplicating
 *  the FROZEN algorithm: the same reader, the same writer, the same bytes. */
export interface V1BaselineFile {
  read(mcp: string): Manifest | null;
  write(mcp: string, manifest: Manifest): void;
}

function readV1File(path: string): Manifest | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
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

function writeV1File(
  dir: string,
  path: string,
  mcp: string,
  manifest: Manifest,
  updatedAt: string,
): void {
    const payload: StoredManifest = {
      v: MANIFEST_VERSION,
      mcp,
      hash: manifest.hash,
      tools: manifest.tools,
      updatedAt: updatedAt,
    };
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

export function createManifestStore(
  baseDir: string,
  opts: ManifestStoreOptions = {},
): ManifestStore {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const dir = join(baseDir, 'manifests');
  const pathFor = (mcp: string): string => join(dir, manifestFileName(mcp));

  const readBaseline = (mcp: string): Manifest | null => readV1File(pathFor(mcp));

  const writeBaseline = (mcp: string, manifest: Manifest): void =>
    writeV1File(dir, pathFor(mcp), mcp, manifest, now());

  function checkAndUpdate(mcp: string, result: unknown): ManifestOutcome {
    const tools = extractTools(result);
    const next = buildManifest(tools);
    const prev = readBaseline(mcp);
    if (prev === null) {
      writeBaseline(mcp, next); // silent seed / reseed
      return { changed: false };
    }
    if (prev.hash === next.hash) return { changed: false }; // no change, no rewrite
    const report = reportChanges(prev, next, tools);
    // Align the baseline to the new manifest either way (never report twice for
    // the same change). report is null only in the hash-differs-but-no-diff
    // edge; still reseed silently.
    const before = Object.keys(prev.tools).length;
    writeBaseline(mcp, next);
    if (report === null) return { changed: false };
    return {
      changed: true,
      change: {
        ...report,
        snapshot: { before: `sha256:${prev.hash}`, after: `sha256:${next.hash}` },
        catalog: { before, after: Object.keys(next.tools).length },
      },
    };
  }

  return { checkAndUpdate };
}

/**
 * The v1 file, read and written with the frozen algorithm and nothing else.
 *
 * WHY THIS EXISTS. v2 owns the baseline now, but a user who downgrades must
 * land on a v1 file that still describes their connectors — otherwise the old
 * build reseeds silently and the first real change after the downgrade goes
 * unreported. Keeping it written for a minimum of two published versions is
 * what makes the downgrade safe; after that it can stop.
 */
export function createV1BaselineFile(
  baseDir: string,
  opts: ManifestStoreOptions = {},
): V1BaselineFile {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const dir = join(baseDir, 'manifests');
  const pathFor = (mcp: string): string => join(dir, manifestFileName(mcp));
  return {
    read: (mcp) => readV1File(pathFor(mcp)),
    write: (mcp, manifest) => writeV1File(dir, pathFor(mcp), mcp, manifest, now()),
  };
}
