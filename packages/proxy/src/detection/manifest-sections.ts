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


import {
  canonicalizeCollection,
  canonicalize,
  reportChanges,
  type ChangeReport,
  type Manifest,
} from './manifest.js';
import { planMigration } from './manifest-migrate.js';
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
  /** What moved and what a rule made of it. Absent when nothing moved. A
   *  report with no findings is the normal case, and is not a detection. */
  change?: ChangeReport;
  events: BaselineEvent[];
}

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
    baseline.sections[section] = freshSection(section, snapshot, baseline.generation + 1, now);
    writeBaselineV2(deps.baseDir, baseline, now);
    return { ...(change !== undefined ? { change } : {}), events };
  }

  const wire = hashOf(snapshot);
  if (wire === existing.wire_hash) return { ...(change !== undefined ? { change } : {}), events };

  // Wire moved: advance the baseline. Classifying the change is the rules'
  // job, not this layer's.
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
  return { ...(change !== undefined ? { change } : {}), events };
}
