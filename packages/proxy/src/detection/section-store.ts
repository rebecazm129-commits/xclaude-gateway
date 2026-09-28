// The live connector-surface store: v2 baseline, five sections, and the v1
// file kept alive underneath it.
//
// WHY THIS REPLACES createManifestStore ON THE HOT PATH. The v1 baseline stores
// hashes and nothing else, so nothing downstream can ever measure HOW a
// description changed — only that it did. The v2 baseline stores the snapshot,
// which is what makes a heuristic like inserted-text possible at all, and it
// covers resources, templates, prompts and discovery rather than tools alone.
//
// THE DOWNGRADE WINDOW. Every tools/list observation still writes the v1 file
// with the frozen algorithm. A user who installs this build and then goes back
// must land on a v1 file that still describes their connectors; otherwise the
// old build reseeds in silence and the first real change after the downgrade
// goes unreported. This is kept for a minimum of two published versions, after
// which the write can stop and the file can be left to rot harmlessly.
//
// WHAT NEVER ALERTS. Starting to watch a section, migrating a v1 baseline,
// recomputing a projection, repairing a damaged file and failing to assemble a
// snapshot are all facts about the AUDITOR, not about the connector. They are
// emitted as app.manifest_baseline lines, which no counter reads.

import {
  buildManifest,
  createV1BaselineFile,
  extractTools,
  type ChangeReport,
  type V1BaselineFile,
} from './manifest.js';
import {
  observeSection,
  sectionForMethod,
  type BaselineEvent,
} from './manifest-sections.js';
import { readBaselineV2, type SectionName } from './manifest-v2.js';
import type { Attention, ConnectorFinding, ReviewedWith, SnapshotRef } from '@xcg/shared';

export interface SectionObservation {
  section: SectionName;
  /** What moved and what a rule made of it. Absent when nothing moved, when
   *  the section was only just seeded, or when the snapshot was incomplete. */
  change?: ChangeReport;
  /** The snapshot hashes before and after. Absent on a seed, where there is no
   *  "before" to point at. */
  snapshot?: { before: string | null; after: string };
  /** A heuristic's opinion that a human should look. */
  attention?: Attention;
  /** A catalog review that found something (manifest-sections.ts). `snapshot`
   *  names the reviewed catalog: before is null because nothing was compared. */
  review?: { findings: ConnectorFinding[]; reviewedWith: ReviewedWith; snapshot: SnapshotRef };
  /** Lifecycle facts. Never a detection, never counted. */
  events: BaselineEvent[];
}

export interface SectionStore {
  /**
   * Observes one JSON-RPC result. Returns null when the method is not one of
   * the five surface reads, which is the common case on a busy connector.
   */
  observe(mcp: string, method: string, result: unknown): SectionObservation | null;
}

export interface SectionStoreOptions {
  appVersion: string;
  now?: () => string;
  /** Set false once the downgrade window has passed. */
  maintainV1?: boolean;
}

export function createSectionStore(baseDir: string, opts: SectionStoreOptions): SectionStore {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const maintainV1 = opts.maintainV1 ?? true;
  const v1: V1BaselineFile = createV1BaselineFile(baseDir, { now });

  function observe(mcp: string, method: string, result: unknown): SectionObservation | null {
    const section = sectionForMethod(method);
    if (section === null) return null;

    // The hash BEFORE, read from the file rather than remembered in process:
    // two proxies for the same connector must not disagree about the baseline.
    const before = readBaselineV2(baseDir, mcp);
    const priorHash =
      before.kind === 'ok' ? (before.baseline.sections[section]?.wire_hash ?? null) : null;

    const outcome = observeSection(
      {
        baseDir,
        appVersion: opts.appVersion,
        now,
        // Only tools ever had a v1 baseline; the other four sections have no
        // history to migrate and must never be reported as if they did.
        ...(section === 'tools' ? { readV1: (m: string) => v1.read(m) } : {}),
      },
      mcp,
      section,
      result,
    );

    // Keep the old file in step, with the frozen algorithm, so a downgrade
    // still has a baseline. Only tools: the v1 format cannot express the rest.
    if (maintainV1 && section === 'tools' && outcome.events.every((e) => e.event !== 'snapshot_incomplete')) {
      try {
        v1.write(mcp, buildManifest(extractTools(result)));
      } catch {
        // Best-effort: a failure here costs a downgrade its baseline, never
        // the audit itself.
      }
    }

    const after = readBaselineV2(baseDir, mcp);
    const nextHash =
      after.kind === 'ok' ? (after.baseline.sections[section]?.wire_hash ?? null) : null;

    return {
      section,
      ...(outcome.change !== undefined ? { change: outcome.change } : {}),
      ...(outcome.change !== undefined && nextHash !== null
        ? { snapshot: { before: priorHash, after: nextHash } }
        : {}),
      ...(outcome.attention !== undefined ? { attention: outcome.attention } : {}),
      ...(outcome.review !== undefined
        ? {
            review: {
              findings: outcome.review.findings,
              reviewedWith: outcome.review.reviewedWith,
              snapshot: { before: null, after: outcome.review.wireHash },
            },
          }
        : {}),
      events: outcome.events,
    };
  }

  return { observe };
}
