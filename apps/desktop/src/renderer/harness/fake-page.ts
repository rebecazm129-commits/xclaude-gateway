// The harness's stand-in for detection:page.
//
// WHY IT HAS TO FILTER. In the product the main process does it — matchesFilter
// (main/detection-page.ts:145) over matchesPreSeverity (:87), with facets from
// computeFacets (:224) — and the renderer only ships a DetectionFilter and
// renders what comes back. A fake that ignores the filter therefore renders a
// toolbar that does nothing: the chips move, the list does not, and every facet
// count reads (0/0). That makes the harness useless for reviewing exactly the
// part of the UI that is hardest to reason about on paper.
//
// It is a REPLICA, not the real code, and that is a real limitation: if the
// main process changes its semantics, this drifts and the harness starts
// lying. Two things keep that honest — it is ported axis by axis with the
// source lines named above, and nothing it does can reach a real detection,
// because there is no main process here to ask.
//
// Deliberately NOT replicated: pagination (the fixtures are small enough to
// return whole) and severity counts over the category-filtered set, which is
// computed here the same way but from the fixture rows rather than events.

import type {
  DetectionFacets,
  DetectionFilter,
  DetectionPageResult,
  DetectionRowSlim,
  Severity,
} from '../../shared/types.js';
import type { Scenario } from './fixtures.js';

const active = (v: readonly string[] | null | undefined): v is readonly string[] =>
  v !== undefined && v !== null && v.length > 0;

/** Mirrors withinTimeWindow: 'all' passes everything, 'custom' needs both ends. */
function withinTime(row: DetectionRowSlim, filter: DetectionFilter, now: number): boolean {
  const ts = Date.parse(row.ts);
  if (filter.timeRange === 'all') return true;
  if (filter.timeRange === 'custom') {
    const range = filter.customRange;
    if (range === undefined || range === null) return true;
    return ts >= Date.parse(range.from) && ts <= Date.parse(range.to);
  }
  const spans: Record<string, number> = {
    '1h': 3_600_000,
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
  };
  const span = spans[filter.timeRange];
  return span === undefined || ts >= now - span;
}

/** Everything matchesPreSeverity checks, in the same order and with the same
 *  "absent field under an active filter still excludes" rule. */
function matchesPreSeverity(row: DetectionRowSlim, filter: DetectionFilter, now: number): boolean {
  if (filter.mcp !== null && row.mcp !== filter.mcp) return false;
  if (active(filter.tool) && (row.toolName === undefined || !filter.tool.includes(row.toolName))) {
    return false;
  }
  if (
    active(filter.ccSession) &&
    (row.ccSession === undefined || !filter.ccSession.includes(row.ccSession))
  ) {
    return false;
  }
  if (active(filter.project) && (row.project === undefined || !filter.project.includes(row.project))) {
    return false;
  }
  if (filter.text !== undefined && filter.text !== null && filter.text !== '') {
    const q = filter.text.toLowerCase();
    const hitTool = row.toolName !== undefined && row.toolName.toLowerCase().includes(q);
    const hitArgs = row.argsSummary !== undefined && row.argsSummary.toLowerCase().includes(q);
    if (!hitTool && !hitArgs) return false;
  }
  // A request with no matched response is neither ok nor error, so ANY active
  // status filter excludes it.
  if (active(filter.status)) {
    if (row.outcome === undefined || !filter.status.includes(row.outcome)) return false;
  }
  if (!withinTime(row, filter, now)) return false;
  if (!filter.sources.includes(row.source)) return false;
  // "Flagged only" arrives as a narrowed category list, never as a flag of its
  // own — the same way the real filter carries it.
  return filter.categories.includes(row.category);
}

/** Facets are computed over the BASE filter (sources + time) only: an
 *  inventory that depended on its own axis would make a chip unable to widen
 *  its own selection. Mirrors computeFacets. */
function facetsOf(rows: readonly DetectionRowSlim[], filter: DetectionFilter, now: number): DetectionFacets {
  const tools = new Set<string>();
  const projects = new Set<string>();
  const sessions = new Map<string, { started: string; newestTs: string; newestMcp: string; proj?: string }>();
  for (const row of rows) {
    if (!withinTime(row, filter, now)) continue;
    if (!filter.sources.includes(row.source)) continue;
    if (row.toolName !== undefined) tools.add(row.toolName);
    if (row.project !== undefined) projects.add(row.project);
    if (row.ccSession !== undefined) {
      const seen = sessions.get(row.ccSession);
      if (seen === undefined) {
        sessions.set(row.ccSession, {
          started: row.ts,
          newestTs: row.ts,
          newestMcp: row.mcp,
          ...(row.project !== undefined ? { proj: row.project } : {}),
        });
      } else {
        if (row.ts < seen.started) seen.started = row.ts;
        if (row.ts > seen.newestTs) {
          seen.newestTs = row.ts;
          seen.newestMcp = row.mcp;
          if (row.project !== undefined) seen.proj = row.project;
        }
      }
    }
  }
  return {
    tools: [...tools].sort(),
    projects: [...projects].sort(),
    ccSessions: [...sessions.entries()]
      .map(([id, s]) => ({ id, started: s.started, where: s.proj ?? s.newestMcp }))
      .sort((a, b) => b.started.localeCompare(a.started)),
  };
}

export function fakePage(s: Scenario, filter: DetectionFilter): DetectionPageResult {
  // Fixed clock: the fixtures carry absolute timestamps, and a wall clock
  // would make the 1h/24h segments behave differently every day.
  const now = Date.parse('2026-09-24T12:30:00.000Z');
  const all = s.rows;
  const preSeverity = all.filter((r) => matchesPreSeverity(r, filter, now));
  const matching = preSeverity.filter((r) => filter.severities.includes(r.severity));

  const severityCounts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of preSeverity) severityCounts[r.severity] += 1;

  return {
    rows: matching,
    total: all.length,
    totalMatching: matching.length,
    severityCounts,
    categoryFilteredTotal: preSeverity.length,
    nextCursor: null,
    facets: facetsOf(all, filter, now),
    authAlerts: [...s.authAlerts],
    retention: s.retention,
  };
}
