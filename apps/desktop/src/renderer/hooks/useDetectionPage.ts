import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ConnectorAuthAlert,
  DetectionCursor,
  DetectionFacets,
  DetectionFilter,
  DetectionPageResult,
  DetectionRowSlim,
  RetentionBannerInfo,
  Severity,
} from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;
export const PAGE_LIMIT = 200;

const EMPTY_COUNTS: Record<Severity, number> = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

const EMPTY_FACETS: DetectionFacets = { tools: [], ccSessions: [], projects: [] };

export interface PolledPage {
  rows: DetectionRowSlim[];
  total: number;
  totalMatching: number;
  severityCounts: Record<Severity, number>;
  categoryFilteredTotal: number;
  facets: DetectionFacets;
  authAlerts: ConnectorAuthAlert[];
  retention: RetentionBannerInfo | null;
  hasMore: boolean;
  loadMore: () => void;
}

// Live "head" page (top-N newest) polled every 2s + stable older pages appended
// on demand via loadMore. The head poll keeps counts/banner/authAlerts fresh
// without re-fetching history; older pages are immutable once loaded. Changing
// the filter resets everything. Combined rows are deduped by id (the head can
// grow into the older region as new events arrive).
export function useDetectionPage(filter: DetectionFilter): PolledPage {
  const filterKey = JSON.stringify(filter);
  const [head, setHead] = useState<DetectionPageResult | null>(null);
  const [older, setOlder] = useState<DetectionRowSlim[]>([]);
  const loadingRef = useRef(false);

  // Head poll. Resets older history whenever the filter changes.
  useEffect(() => {
    setOlder([]);
    loadingRef.current = false;
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const r = await window.xcg.listDetectionPage({
          filter,
          limit: PAGE_LIMIT,
          cursor: null,
        });
        if (!cancelled) setHead(r);
      } catch (err) {
        console.error('detection:page failed:', err);
      }
    }
    void refresh();
    const handle = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [filterKey]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: DetectionRowSlim[] = [];
    for (const r of [...(head?.rows ?? []), ...older]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }, [head, older]);

  const totalMatching = head?.totalMatching ?? 0;
  const hasMore = rows.length < totalMatching;

  const loadMore = useCallback(() => {
    if (loadingRef.current) return;
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length >= totalMatching) return;
    loadingRef.current = true;
    const cursor: DetectionCursor = { ts: last.ts, id: last.id };
    void window.xcg
      .listDetectionPage({ filter, limit: PAGE_LIMIT, cursor })
      .then((r) => {
        setOlder((prev) => [...prev, ...r.rows]);
      })
      .catch((err) => console.error('detection:page (more) failed:', err))
      .finally(() => {
        loadingRef.current = false;
      });
  }, [filterKey, rows, totalMatching]);

  return {
    rows,
    total: head?.total ?? 0,
    totalMatching,
    severityCounts: head?.severityCounts ?? EMPTY_COUNTS,
    categoryFilteredTotal: head?.categoryFilteredTotal ?? 0,
    facets: head?.facets ?? EMPTY_FACETS,
    authAlerts: head?.authAlerts ?? [],
    retention: head?.retention ?? null,
    hasMore,
    loadMore,
  };
}
