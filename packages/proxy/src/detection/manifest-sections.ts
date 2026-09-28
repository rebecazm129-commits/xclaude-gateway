// Observing a connector's sections and keeping the v2 baseline for each.
//
// SCOPE OF THIS LAYER. It decides what is TRACKED, not what is dangerous.
// Seeding a section, migrating a v1 baseline, recomputing a projection and
// advancing a hash all happen here. Classifying a change as a finding is the
// tools detector's job (diffManifest) and, for the other sections, still to
// come — a wire change outside `tools` updates the baseline and is reported as
// a lifecycle fact, not yet as a rule finding. Recording the surface before
// judging it is the right order: a baseline that only starts on the day the
// classifier ships has nothing to compare against on that day.


import type { Attention, ConnectorChangeEntry, ConnectorFinding, ReviewedWith, RuleId } from '@xcg/shared';

import {
  REVIEW_RULES,
  buildManifest,
  canonicalizeCollection,
  canonicalize,
  reportChanges,
  reviewToolSurfaces,
  type ChangeReport,
  type Manifest,
  type ToolDef,
} from './manifest.js';
import { RULE_VERSIONS } from './rules.js';
import { planMigration } from './manifest-migrate.js';
import { attentionFor, descriptionsOf } from './heuristics.js';
import {
  SECURITY_PROJECTION_VERSION,
  emptyBaseline,
  pushRecent,
  readBaselineV2,
  sha256,
  writeBaselineV2,
  type BaselineV2,
  type SectionName,
  type SectionState,
} from './manifest-v2.js';
import { projectForSecurity } from './security-projection.js';

/** The JSON-RPC method each section is read from, and the result key holding
 *  its collection. `discovery` has no collection: its result IS the object. */
export const SECTION_SOURCE: Record<SectionName, { method: string; key: string | null }> = {
  discovery: { method: 'server/discover', key: null },
  tools: { method: 'tools/list', key: 'tools' },
  resources: { method: 'resources/list', key: 'resources' },
  resource_templates: { method: 'resources/templates/list', key: 'resourceTemplates' },
  prompts: { method: 'prompts/list', key: 'prompts' },
};

export function sectionForMethod(method: string): SectionName | null {
  for (const [name, src] of Object.entries(SECTION_SOURCE)) {
    if (src.method === method) return name as SectionName;
  }
  return null;
}

/** Lifecycle facts about the auditor's own baseline. Never a connector change. */
export interface BaselineEvent {
  event: 'section_initialized' | 'migrated' | 'projection_migrated' | 'reseeded' | 'snapshot_incomplete';
  section?: SectionName;
  reason?: 'absent' | 'corrupt' | 'version_mismatch' | 'future_version';
  coverageExpanded?: readonly string[];
  fromVersion?: number;
  toVersion?: number;
}

export interface SectionOutcome {
  /** A heuristic's opinion that a human should look. Computed from the STORED
   *  snapshot, which is the only place the previous text exists. */
  attention?: Attention;
  /** What moved and what a rule made of it. Absent when nothing moved. A
   *  report with no findings is the normal case, and is not a detection. */
  change?: ChangeReport;
  /** A catalog review that found something: the tools section as it stands,
   *  judged by the review rules. Separate from `change` — a review and a
   *  change can happen in the same observation and are different facts. */
  review?: CatalogReview;
  events: BaselineEvent[];
}

export interface CatalogReview {
  findings: ConnectorFinding[];
  /** The rule versions this review ran with — what reviewed_with now says. */
  reviewedWith: ReviewedWith;
  /** wire hash of the catalog that was reviewed. */
  wireHash: string;
}

// ---- catalog review ----------------------------------------------------------
//
// A baseline used to be seeded in silence: the first catalog a connector ever
// showed was never judged by any rule, only what changed after it. So a
// connector that arrived already poisoned was never looked at.
//
// The tools section is now REVIEWED as it stands, by the rules that judge what
// a definition says (REVIEW_RULES — never sensitive_param_added, which judges
// what was added). It happens in two situations, and in each exactly once:
//   - the seed: the first time a catalog is seen;
//   - a rule's version going up (including baselines from before the review,
//     which carry no reviewed_with): the STORED snapshot is reviewed once,
//     with only the rules whose version rose, so a finding already reported
//     is not reported again.
// A clean review is silent, as the seed always was. A review with findings is
// emitted as a connector_change with no changes and review: 'baseline'. The
// severities are the ones the same finding gets in a change.

/** The review rules at their current versions. */
function currentReviewVersions(): ReviewedWith {
  const out: ReviewedWith = {};
  for (const r of REVIEW_RULES) out[r] = RULE_VERSIONS[r];
  return out;
}

/** Review rules whose current version is above what the catalog was reviewed
 *  with. A missing entry, or a missing reviewed_with, is version 0. */
function staleReviewRules(reviewed: ReviewedWith | undefined): Set<RuleId> {
  return new Set(REVIEW_RULES.filter((r) => (reviewed?.[r] ?? 0) < RULE_VERSIONS[r]));
}

const toolsOf = (snapshot: unknown): ToolDef[] =>
  itemsOf(snapshot).filter((i) => typeof i['name'] === 'string') as unknown as ToolDef[];

/** Does this result declare more pages? A non-empty nextCursor means the
 *  collection in hand is partial. */
export function isPaginated(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const cursor = (result as Record<string, unknown>)['nextCursor'];
  return typeof cursor === 'string' && cursor !== '';
}

/** Canonical snapshot of a section result, or null when the shape is not what
 *  the section expects (a malformed result must not overwrite a good
 *  baseline). */
export function snapshotOf(section: SectionName, result: unknown): unknown | null {
  if (result === null || typeof result !== 'object') return null;
  const key = SECTION_SOURCE[section].key;
  if (key === null) return canonicalize(result);
  const items = (result as Record<string, unknown>)[key];
  if (!Array.isArray(items)) return null;
  return { items: canonicalizeCollection(items) };
}

const hashOf = (value: unknown): string => `sha256:${sha256(JSON.stringify(value))}`;

function freshSection(
  section: SectionName,
  snapshot: unknown,
  generation: number,
  now: string,
): SectionState {
  const wire = hashOf(snapshot);
  return {
    state: 'current',
    wire_hash: wire,
    security_hash: hashOf(projectForSecurity(section, snapshot)),
    snapshot,
    pages: 1,
    initialized_at: now,
    last_changed_generation: generation,
    recent_wire_hashes: [wire],
  };
}

const itemsOf = (snapshot: unknown): Record<string, unknown>[] => {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const items = Array.isArray(snapshot) ? snapshot : (snapshot as Record<string, unknown>)['items'];
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
};

const nameOf = (item: Record<string, unknown>): string | null => {
  for (const key of ['name', 'uri', 'uriTemplate']) {
    const v = item[key];
    if (typeof v === 'string') return v;
  }
  return null;
};

/** What moved between two stored snapshots of one section. */
function changeBetween(
  section: SectionName,
  before: unknown,
  after: unknown,
): ChangeReport | null {
  const prevItems = itemsOf(before);
  const nextItems = itemsOf(after);
  if (section === 'tools') {
    // The full classifier: same rules, same grading, same frozen v1 shape.
    // A stored item with no name is not a tool the v1 algorithm can express,
    // so it is dropped rather than coerced.
    const asTools = (items: Record<string, unknown>[]): ToolDef[] =>
      items.filter((i) => typeof i['name'] === 'string') as unknown as ToolDef[];
    const prevTools = asTools(prevItems);
    const nextTools = asTools(nextItems);
    return reportChanges(buildManifest(prevTools), buildManifest(nextTools), nextTools);
  }
  // Generic item diff. No rule reads these sections yet, so no findings — the
  // change is recorded as the fact it is.
  const prev = new Map<string, Record<string, unknown>>();
  for (const i of prevItems) {
    const n = nameOf(i);
    if (n !== null) prev.set(n, i);
  }
  const next = new Map<string, Record<string, unknown>>();
  for (const i of nextItems) {
    const n = nameOf(i);
    if (n !== null) next.set(n, i);
  }
  const changes: ConnectorChangeEntry[] = [];
  for (const name of [...new Set([...prev.keys(), ...next.keys()])].sort()) {
    const p = prev.get(name);
    const n = next.get(name);
    if (p === undefined) changes.push({ kind: 'item_added', target: name });
    else if (n === undefined) changes.push({ kind: 'item_removed', target: name });
    else if (p['description'] !== n['description']) {
      changes.push({ kind: 'description_changed', target: name, path: '$.description' });
    } else if (JSON.stringify(p) !== JSON.stringify(n)) {
      changes.push({ kind: 'schema_changed', target: name });
    }
  }
  return changes.length > 0 ? { changes, findings: [] } : null;
}

export interface ObserveDeps {
  baseDir: string;
  appVersion: string;
  now: () => string;
  /** The stored v1 baseline for this connector, read with the FROZEN v1
   *  algorithm. Only consulted for the `tools` section, and only when v2 has
   *  no tools section yet. */
  readV1?: (mcp: string) => Manifest | null;
}

/**
 * Observes one section of one connector and brings its v2 baseline up to date.
 *
 * Order of the checks matters and each one has a reason:
 *   future file   → leave it entirely alone (a newer build owns it)
 *   corrupt file  → integrity warning, then reseed
 *   absent file   → seed, section_initialized
 *   projection    → recompute from the STORED snapshot, never from the wire
 *   no section    → seed it; for `tools`, migrate from v1 first
 *   wire changed  → advance the baseline
 */
export function observeSection(
  deps: ObserveDeps,
  mcp: string,
  section: SectionName,
  result: unknown,
): SectionOutcome {
  const events: BaselineEvent[] = [];

  // A paginated result is ONE PAGE, not the surface. Advancing the baseline on
  // it would record a catalogue with most of its items missing, and the next
  // full read would then look like a mass addition. Report that the auditor
  // could not assemble the snapshot and leave the baseline exactly as it was.
  // No connector in the 4-month corpus paginates tools/list (0 of 2875), but
  // the spec allows it and a rug pull has an obvious incentive to use it.
  if (isPaginated(result)) {
    events.push({ event: 'snapshot_incomplete', section });
    return { events };
  }

  const snapshot = snapshotOf(section, result);
  // A result that does not carry the section's collection is not evidence of
  // anything: leaving the baseline untouched is the only safe reading.
  if (snapshot === null) return { events };

  const now = deps.now();
  const read = readBaselineV2(deps.baseDir, mcp);

  if (read.kind === 'future') return { events };

  let baseline: BaselineV2;
  if (read.kind === 'ok') {
    baseline = read.baseline;
    if (read.droppedSections.includes(section)) {
      events.push({ event: 'reseeded', reason: 'corrupt', section });
    }
  } else {
    if (read.kind === 'corrupt') events.push({ event: 'reseeded', reason: 'corrupt' });
    baseline = emptyBaseline(mcp, deps.appVersion, now);
  }

  // OUR rules changed, not theirs: recompute every stored section's security
  // hash from its snapshot and say so. Never a manifest change.
  if (
    read.kind === 'ok' &&
    baseline.security_projection_version !== SECURITY_PROJECTION_VERSION
  ) {
    const from = baseline.security_projection_version;
    for (const [name, state] of Object.entries(baseline.sections)) {
      if (state === undefined) continue;
      state.security_hash = hashOf(projectForSecurity(name as SectionName, state.snapshot));
    }
    baseline.security_projection_version = SECURITY_PROJECTION_VERSION;
    events.push({
      event: 'projection_migrated',
      fromVersion: from,
      toVersion: SECURITY_PROJECTION_VERSION,
    });
  }

  const existing = baseline.sections[section];
  let change: ChangeReport | undefined;

  if (existing === undefined) {
    // First time this section is tracked. For `tools` a v1 baseline may exist,
    // and a real change under the OLD rules is reported before migrating.
    if (section === 'tools' && deps.readV1 !== undefined) {
      const plan = planMigration(deps.readV1(mcp), result);
      if (plan.v1Change !== null) change = plan.v1Change;
      events.push({ event: 'migrated', coverageExpanded: plan.coverageExpanded });
    }
    events.push({ event: 'section_initialized', section });
    const fresh = freshSection(section, snapshot, baseline.generation + 1, now);
    // Review the catalog seen for the first time. Not when a v1 migration
    // just reported a change: that report already judged what moved, and
    // leaving reviewed_with unset makes the NEXT observation review the stored
    // catalog once — one fact per event.
    let review: CatalogReview | undefined;
    if (section === 'tools' && change === undefined) {
      fresh.reviewed_with = currentReviewVersions();
      const findings = reviewToolSurfaces(toolsOf(snapshot), new Set(REVIEW_RULES));
      if (findings.length > 0) {
        review = { findings, reviewedWith: fresh.reviewed_with, wireHash: fresh.wire_hash };
      }
    }
    baseline.sections[section] = fresh;
    writeBaselineV2(deps.baseDir, baseline, now);
    return {
      ...(change !== undefined ? { change } : {}),
      ...(review !== undefined ? { review } : {}),
      events,
    };
  }

  // A rule got a new version since this catalog was reviewed (or it never was):
  // review the STORED catalog once, with the rules that moved, and record it.
  let review: CatalogReview | undefined;
  let reviewed = false;
  if (section === 'tools') {
    const stale = staleReviewRules(existing.reviewed_with);
    if (stale.size > 0) {
      const findings = reviewToolSurfaces(toolsOf(existing.snapshot), stale);
      existing.reviewed_with = { ...existing.reviewed_with, ...currentReviewVersions() };
      reviewed = true;
      if (findings.length > 0) {
        review = { findings, reviewedWith: existing.reviewed_with, wireHash: existing.wire_hash };
      }
    }
  }

  const wire = hashOf(snapshot);
  if (wire === existing.wire_hash) {
    // Nothing moved; only the review mark did, and it must persist.
    if (reviewed) writeBaselineV2(deps.baseDir, baseline, now);
    return {
      ...(change !== undefined ? { change } : {}),
      ...(review !== undefined ? { review } : {}),
      events,
    };
  }

  // Wire moved: say what moved, then advance the baseline.
  //
  // `tools` goes through the full classifier, which is the only section that
  // has one: it rebuilds both v1-shaped manifests from the snapshots and runs
  // the same rules the frozen path ran. The other four sections get an item
  // diff and NO findings, because no rule reads them yet — recording the
  // surface before judging it is the right order, and a baseline that only
  // starts the day the classifier ships has nothing to compare against.
  change = changeBetween(section, existing.snapshot, snapshot) ?? change;

  // The heuristic reads the PREVIOUS snapshot — the only place the old text
  // exists, and the reason the v2 baseline stores snapshots at all.
  const beforeDesc = descriptionsOf(existing.snapshot);
  const afterDesc = descriptionsOf(snapshot);
  let moved = 0;
  for (const [name, after] of afterDesc) {
    const before = beforeDesc.get(name);
    if (before === undefined || before !== after) moved += 1;
  }
  for (const name of beforeDesc.keys()) if (!afterDesc.has(name)) moved += 1;
  const attention = attentionFor({ affectedItems: moved, before: beforeDesc, after: afterDesc });

  baseline.sections[section] = {
    ...existing,
    state: 'current',
    wire_hash: wire,
    security_hash: hashOf(projectForSecurity(section, snapshot)),
    snapshot,
    last_changed_generation: baseline.generation + 1,
    recent_wire_hashes: pushRecent(existing.recent_wire_hashes, wire),
  };
  writeBaselineV2(deps.baseDir, baseline, now);
  return {
    ...(change !== undefined ? { change } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(attention.level === 'review_recommended' ? { attention } : {}),
    events,
  };
}
