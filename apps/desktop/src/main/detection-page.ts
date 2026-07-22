// Pure pagination/filtering/projection for the Detections view. Operates on the
// already-assembled, ts-desc event list from the AuditStore. Filters are applied
// BEFORE the top-N cut (so counts never lie), and the cut walks a stable total
// order (ts desc, id desc) via a compound cursor.

import { basename } from 'node:path';

import type {
  CcSessionFacet,
  DetectionCursor,
  DetectionDetail,
  DetectionFacets,
  DetectionFilter,
  DetectionRowSlim,
  EnrichableEvent,
  Severity,
  TimeRange,
} from '../shared/types.js';
import { DAY_MS, normalizeSource } from '../shared/types.js';

const TIME_WINDOW_MS: Record<Exclude<TimeRange, 'all' | 'custom'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Total order for the cursor: ts desc, then id desc as a deterministic
// tie-break (equal-ms events get a stable, walkable order).
function cmp(
  a: { ts: string; id: string },
  b: { ts: string; id: string },
): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function withinTimeWindow(
  e: EnrichableEvent,
  filter: DetectionFilter,
  now: number,
): boolean {
  if (filter.timeRange === 'all') return true;
  const t = Date.parse(e.ts);
  if (Number.isNaN(t)) return false;
  // Custom range (delta final): explicit YYYY-MM-DD from/to, inclusive on
  // both ends ([from 00:00, to 24:00)). Absent/null range → no restriction.
  if (filter.timeRange === 'custom') {
    const cr = filter.customRange;
    if (cr === undefined || cr === null) return true;
    const from = Date.parse(cr.from);
    const to = Date.parse(cr.to);
    if (!Number.isNaN(from) && t < from) return false;
    if (!Number.isNaN(to) && t >= to + DAY_MS) return false;
    return true;
  }
  return t >= now - TIME_WINDOW_MS[filter.timeRange];
}

// mcp + time + category (pre-severity). paginate uses this for the category-
// filtered set (the severity breakdown is computed over it); matchesFilter
// composes the full predicate on top.
export function matchesPreSeverity(
  e: EnrichableEvent,
  filter: DetectionFilter,
  now: number,
): boolean {
  if (filter.mcp !== null && e.mcp !== filter.mcp) return false;
  // CC filters (F2.4, multi-select since commit 6): absent ≡ null ≡ [] ≡ no
  // filter; otherwise array membership. tool matches toolName (requests only
  // — an active tool filter excludes enrichment rows); ccSession matches both
  // kinds (CC enrichments carry it); project matches basename(cwd) (requests
  // with cwd only). Wrapper/historical events lacking the field are excluded
  // by an active filter on it.
  if (filter.tool !== undefined && filter.tool !== null && filter.tool.length > 0) {
    if (e.type !== 'mcp.request' || e.toolName === undefined || !filter.tool.includes(e.toolName)) {
      return false;
    }
  }
  if (
    filter.ccSession !== undefined &&
    filter.ccSession !== null &&
    filter.ccSession.length > 0 &&
    (e.ccSession === undefined || !filter.ccSession.includes(e.ccSession))
  ) {
    return false;
  }
  if (filter.project !== undefined && filter.project !== null && filter.project.length > 0) {
    if (e.type !== 'mcp.request' || e.cwd === undefined || !filter.project.includes(basename(e.cwd))) {
      return false;
    }
  }
  // Free-text search (delta final): case-insensitive against toolName and
  // argsSummary — requests only (enrichments carry neither).
  if (filter.text !== undefined && filter.text !== null && filter.text !== '') {
    if (e.type !== 'mcp.request') return false;
    const q = filter.text.toLowerCase();
    const hitTool = e.toolName !== undefined && e.toolName.toLowerCase().includes(q);
    const hitArgs = e.argsSummary !== undefined && e.argsSummary.toLowerCase().includes(q);
    if (!hitTool && !hitArgs) return false;
  }
  // Status filter (delta final): ok/error membership. Requests without a
  // matched response (outcome undefined) are excluded by ANY active status
  // filter — they are neither ok nor error.
  if (filter.status !== undefined && filter.status !== null && filter.status.length > 0) {
    if (e.type !== 'mcp.request' || e.outcome === undefined || !filter.status.includes(e.outcome)) {
      return false;
    }
  }
  if (!withinTimeWindow(e, filter, now)) return false;
  if (!filter.sources.includes(normalizeSource(e.source))) return false;
  return filter.categories.includes(e.detection.category);
}

// Full filter (mcp + time + category + severity). Equals paginate's `matching`
// predicate by construction — the audit exporter reuses exactly this, so the
// export and the view filter identically.
export function matchesFilter(
  e: EnrichableEvent,
  filter: DetectionFilter,
  now: number,
): boolean {
  return (
    matchesPreSeverity(e, filter, now) &&
    filter.severities.includes(e.detection.severity)
  );
}

export function toSlim(e: EnrichableEvent): DetectionRowSlim {
  const row: DetectionRowSlim = {
    id: e.id,
    ts: e.ts,
    mcp: e.mcp,
    type: e.type,
    category: e.detection.category,
    severity: e.detection.severity,
    source: normalizeSource(e.source),
  };
  // CC provenance (F2.4): ccSession on both kinds (CC enrichments carry it);
  // project only on requests (cwd doesn't travel in enrichments). The row
  // ships basename(cwd) — the short name the UI renders — not the full path.
  if (e.ccSession !== undefined) row.ccSession = e.ccSession;
  if (e.type === 'mcp.request') {
    if (e.toolName !== undefined) row.toolName = e.toolName;
    row.method = e.method;
    if (e.cwd !== undefined) row.project = basename(e.cwd);
    if (e.argsSummary !== undefined) row.argsSummary = e.argsSummary;
    if (e.outcome !== undefined) row.outcome = e.outcome;
  }
  return row;
}

export function toDetail(e: EnrichableEvent): DetectionDetail {
  const detail: DetectionDetail = {
    id: e.id,
    ts: e.ts,
    session: e.session,
    mcp: e.mcp,
    type: e.type,
    rpcId: e.rpcId,
    direction: e.direction,
    category: e.detection.category,
    severity: e.detection.severity,
    source: normalizeSource(e.source),
    findings: e.detection.findings,
  };
  if (e.type === 'mcp.request') {
    detail.method = e.method;
    if (e.toolName !== undefined) detail.toolName = e.toolName;
    if (e.argumentsJson !== undefined) detail.argumentsJson = e.argumentsJson;
    if (e.overheadUs !== undefined) detail.overheadUs = e.overheadUs;
  }
  return detail;
}

export interface PageSlice {
  rows: DetectionRowSlim[];
  total: number;
  totalMatching: number;
  severityCounts: Record<Severity, number>;
  categoryFilteredTotal: number;
  nextCursor: DetectionCursor | null;
  facets: DetectionFacets;
}

// computeFacets — stable inventories for the CC chips (commit 6): distinct
// tool/ccSession/project over the BASE filter only (sources + timeRange) —
// deliberately NOT mcp/categories/severities/tool/ccSession/project, so a
// facet's own selection never shrinks its inventory. One O(n) pass with three
// Sets over the already-cached slim events — same order of cost as paginate's
// existing category pass (sub-ms at the golden-oracle scale, a few ms at 1M).
function computeFacets(
  events: readonly EnrichableEvent[],
  filter: DetectionFilter,
  now: number,
): DetectionFacets {
  const tools = new Set<string>();
  const projects = new Set<string>();
  // Per-session accumulator (delta final): started = min ts; where = the
  // most recent project seen in the session, else the mcp of its newest
  // event. Same single pass as the other facets.
  interface SessionAcc {
    started: string;
    newestTs: string;
    newestMcp: string;
    proj?: string;
    projTs?: string;
  }
  const sessions = new Map<string, SessionAcc>();
  for (const e of events) {
    if (!withinTimeWindow(e, filter, now)) continue;
    if (!filter.sources.includes(normalizeSource(e.source))) continue;
    const proj =
      e.type === 'mcp.request' && e.cwd !== undefined ? basename(e.cwd) : undefined;
    if (e.ccSession !== undefined) {
      const s = sessions.get(e.ccSession);
      if (s === undefined) {
        sessions.set(e.ccSession, {
          started: e.ts,
          newestTs: e.ts,
          newestMcp: e.mcp,
          ...(proj !== undefined ? { proj, projTs: e.ts } : {}),
        });
      } else {
        if (e.ts < s.started) s.started = e.ts;
        if (e.ts > s.newestTs) {
          s.newestTs = e.ts;
          s.newestMcp = e.mcp;
        }
        if (proj !== undefined && (s.projTs === undefined || e.ts > s.projTs)) {
          s.proj = proj;
          s.projTs = e.ts;
        }
      }
    }
    if (e.type === 'mcp.request') {
      if (e.toolName !== undefined) tools.add(e.toolName);
      if (proj !== undefined) projects.add(proj);
    }
  }
  const ccSessions: CcSessionFacet[] = [...sessions]
    .map(([id, s]) => ({ id, started: s.started, where: s.proj ?? s.newestMcp }))
    .sort((a, b) => b.started.localeCompare(a.started)); // recent-first
  return {
    tools: [...tools].sort(),
    ccSessions,
    projects: [...projects].sort(),
  };
}

// Filters (mcp + time + category → then severity), computes the counts the UI
// needs, then returns the page after `cursor` (top-N of the filtered, ordered
// set). `now` drives the relative time window.
export function paginate(
  events: readonly EnrichableEvent[],
  filter: DetectionFilter,
  limit: number,
  cursor: DetectionCursor | null,
  now: number,
): PageSlice {
  const total = events.length;

  // Pre-severity filter: mcp + time + category. severityCounts and the
  // breakdown total are computed over THIS set (matches the old client).
  const categoryFiltered = events.filter((e) => matchesPreSeverity(e, filter, now));

  const severityCounts: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const e of categoryFiltered) severityCounts[e.detection.severity] += 1;
  const categoryFilteredTotal = categoryFiltered.length;

  // Severity filter → the matching set.
  const matching = categoryFiltered.filter((e) =>
    filter.severities.includes(e.detection.severity),
  );
  const totalMatching = matching.length;

  // Stable total order for the cursor walk.
  const sorted = matching.slice().sort(cmp);
  const from =
    cursor === null
      ? 0
      : (() => {
          const idx = sorted.findIndex((e) => cmp(cursor, e) < 0);
          return idx === -1 ? sorted.length : idx;
        })();
  const slice = sorted.slice(from, from + limit);
  const rows = slice.map(toSlim);
  const last = slice[slice.length - 1];
  const nextCursor =
    from + limit < sorted.length && last !== undefined
      ? { ts: last.ts, id: last.id }
      : null;

  const facets = computeFacets(events, filter, now);

  return { rows, total, totalMatching, severityCounts, categoryFilteredTotal, nextCursor, facets };
}
