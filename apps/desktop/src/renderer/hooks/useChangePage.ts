// Connector changes, shaped like a detection page.
//
// WHY NOT useDetectionPage. That one talks to detection:page, which pages
// DetectionRowSlim out of the tool-call trail. Changes are a different source
// and a different row. Extending the existing endpoint with a row variant
// would force DetectionRowSlim to grow fields that are not its own and put two
// models behind one channel.
//
// WHY THE SAME OUTPUT SHAPE. The cards, the chips and the footer are shared
// components that already speak {rows, total, totalMatching, severityCounts,
// facets}. Matching it means Changes reuses them untouched instead of growing
// a second set that drifts.
//
// Filtering happens HERE rather than in the main process, unlike detections.
// The reason is size: a connector change is one row per comparison, 217 across
// four months of a busy install, where tool calls run to hundreds of thousands
// and have to be paged. Filtering a list that small in the renderer costs
// nothing and keeps the IPC surface to "give me the changes".

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ConnectorChangeView } from '../lib/xcgApi.js';
import type { Severity } from '../../shared/types.js';

export type ReviewState = 'reviewed' | 'unreviewed';

export interface ChangeFilter {
  /** Only what still wants a human: attention raised, or findings, unreviewed. */
  needsReviewOnly: boolean;
  /** Only changes a rule said something about. */
  withFindingsOnly: boolean;
  severities: readonly Severity[];
  /** Empty or absent = no filter. */
  review: readonly ReviewState[];
  sections: readonly ConnectorChangeView['section'][];
  mcps: readonly string[];
  /** Case-insensitive, against item names and rule ids. */
  text: string | null;
  timeRange: '1h' | '24h' | '7d' | 'all' | 'custom';
  customRange: { from: string; to: string } | null;
}

export interface ChangeFacets {
  mcps: string[];
  sections: ConnectorChangeView['section'][];
}

export interface ChangePage {
  rows: ConnectorChangeView[];
  /** Every change, unfiltered — what TOTAL counts. */
  total: number;
  totalMatching: number;
  severityCounts: Record<Severity, number>;
  /** Changes carrying at least one rule finding, reviewed or not. */
  withFindingsCount: number;
  /** Unreviewed changes that carry attention or findings. */
  needsReviewCount: number;
  facets: ChangeFacets;
  loading: boolean;
  refresh: () => void;
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The severity of the highest finding, or null when no rule asserted one.
 *  Null is not "low": a change with no finding is not a small problem, it is
 *  no problem that any rule could name. */
export function topSeverity(view: ConnectorChangeView): Severity | null {
  let best: Severity | null = null;
  for (const f of view.findings) {
    const s = f.severity;
    if (best === null || RANK[s] > RANK[best]) best = s;
  }
  return best;
}

export function needsReview(view: ConnectorChangeView): boolean {
  return (
    view.review_status === 'unreviewed' &&
    (view.attention.level === 'review_recommended' || view.findings.length > 0)
  );
}

function withinTime(view: ConnectorChangeView, filter: ChangeFilter, now: number): boolean {
  if (filter.timeRange === 'all') return true;
  const ts = Date.parse(view.ts);
  if (filter.timeRange === 'custom') {
    if (filter.customRange === null) return true;
    return ts >= Date.parse(filter.customRange.from) && ts <= Date.parse(filter.customRange.to);
  }
  const spans = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
  return ts >= now - spans[filter.timeRange];
}

function matchesText(view: ConnectorChangeView, query: string): boolean {
  const q = query.toLowerCase();
  if (view.mcp.toLowerCase().includes(q)) return true;
  for (const c of view.changes) if (c.target.toLowerCase().includes(q)) return true;
  for (const f of view.findings) {
    if (f.rule_id.toLowerCase().includes(q)) return true;
    if (f.evidence.target?.toLowerCase().includes(q) === true) return true;
  }
  return false;
}

/** Everything except the severity axis, so the cards can count over the set
 *  that severity has NOT yet narrowed — the same split detection-page makes. */
function matchesPreSeverity(view: ConnectorChangeView, filter: ChangeFilter, now: number): boolean {
  if (filter.needsReviewOnly && !needsReview(view)) return false;
  if (filter.withFindingsOnly && view.findings.length === 0) return false;
  if (filter.review.length > 0 && !filter.review.includes(view.review_status)) return false;
  if (filter.sections.length > 0 && !filter.sections.includes(view.section)) return false;
  if (filter.mcps.length > 0 && !filter.mcps.includes(view.mcp)) return false;
  if (filter.text !== null && filter.text !== '' && !matchesText(view, filter.text)) return false;
  return withinTime(view, filter, now);
}

export function useChangePage(filter: ChangeFilter, nowMs?: number): ChangePage {
  const [all, setAll] = useState<ConnectorChangeView[] | null>(null);

  const refresh = useCallback(() => {
    const read = window.xcg.connectorChanges?.();
    if (read === undefined) {
      // A preload from an older build: show an empty view rather than throw.
      setAll([]);
      return;
    }
    read.then(setAll).catch(() => setAll([]));
  }, []);

  useEffect(refresh, [refresh]);

  return useMemo(() => {
    const rows = all ?? [];
    const now = nowMs ?? Date.now();
    const preSeverity = rows.filter((r) => matchesPreSeverity(r, filter, now));

    const severityCounts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of preSeverity) {
      const s = topSeverity(r);
      if (s !== null) severityCounts[s] += 1;
    }

    // A change with no finding has no severity to select on, so it survives
    // only while every severity is selected. Narrowing to HIGH must not leave
    // the findings-free majority sitting in the list.
    const allSeverities = filter.severities.length === 4;
    const matching = preSeverity.filter((r) => {
      const s = topSeverity(r);
      return s === null ? allSeverities : filter.severities.includes(s);
    });

    // Facets over the unfiltered set: a chip has to be able to widen its own
    // selection, which it cannot do if its inventory depends on itself.
    const mcps = [...new Set(rows.map((r) => r.mcp))].sort();
    const sections = [...new Set(rows.map((r) => r.section))].sort();

    return {
      rows: matching,
      total: rows.length,
      totalMatching: matching.length,
      severityCounts,
      withFindingsCount: rows.filter((r) => r.findings.length > 0).length,
      needsReviewCount: rows.filter(needsReview).length,
      facets: { mcps, sections },
      loading: all === null,
      refresh,
    };
  }, [all, filter, nowMs, refresh]);
}
