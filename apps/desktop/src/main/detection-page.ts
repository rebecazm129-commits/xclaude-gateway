// Pure pagination/filtering/projection for the Detections view. Operates on the
// already-assembled, ts-desc event list from the AuditStore. Filters are applied
// BEFORE the top-N cut (so counts never lie), and the cut walks a stable total
// order (ts desc, id desc) via a compound cursor.

import type {
  DetectionCursor,
  DetectionDetail,
  DetectionFilter,
  DetectionRowSlim,
  EnrichableEvent,
  Severity,
  TimeRange,
} from '../shared/types.js';

const TIME_WINDOW_MS: Record<Exclude<TimeRange, 'all'>, number> = {
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

export function toSlim(e: EnrichableEvent): DetectionRowSlim {
  const row: DetectionRowSlim = {
    id: e.id,
    ts: e.ts,
    mcp: e.mcp,
    type: e.type,
    category: e.detection.category,
    severity: e.detection.severity,
  };
  if (e.type === 'mcp.request') {
    if (e.toolName !== undefined) row.toolName = e.toolName;
    row.method = e.method;
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
  const catSet = new Set(filter.categories);
  const cutoff =
    filter.timeRange === 'all' ? null : now - TIME_WINDOW_MS[filter.timeRange];
  const categoryFiltered = events.filter((e) => {
    if (filter.mcp !== null && e.mcp !== filter.mcp) return false;
    if (cutoff !== null) {
      const t = Date.parse(e.ts);
      if (Number.isNaN(t) || t < cutoff) return false;
    }
    return catSet.has(e.detection.category);
  });

  const severityCounts: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const e of categoryFiltered) severityCounts[e.detection.severity] += 1;
  const categoryFilteredTotal = categoryFiltered.length;

  // Severity filter → the matching set.
  const sevSet = new Set(filter.severities);
  const matching = categoryFiltered.filter((e) =>
    sevSet.has(e.detection.severity),
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

  return { rows, total, totalMatching, severityCounts, categoryFilteredTotal, nextCursor };
}
