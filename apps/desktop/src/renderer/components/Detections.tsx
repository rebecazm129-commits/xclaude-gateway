import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import type {
  DetectionFilter,
  DetectionRowSlim,
  Severity,
  Category,
} from '../../shared/types.js';

import { DetailDrawer } from './DetailDrawer.js';
import { DetectionRow } from './DetectionRow.js';
import { FilterDropdown } from './FilterDropdown.js';
import { NewEventsPill } from './NewEventsPill.js';
import { SeverityBreakdown } from './SeverityBreakdown.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';

import styles from './Detections.module.css';

const SEVERITY_OPTIONS: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
// Exported so the default-filter membership is unit-testable. The filter is
// server-side, so a category absent here is filtered OUT by default.
export const CATEGORY_OPTIONS: readonly Category[] = [
  'credential_detected',
  'prompt_injection',
  'email_send_warning',
  'data_export_warning',
  'tool_call_allowed',
  'pii_detected',
  'pii_structured',
  'tool_manifest_changed',
];

// Human-readable byte size for the retention banner (1024-based).
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val >= 10 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

const ROW_HEIGHT = 40;
// Chrome around the virtualized list: titlebar (42) + header (84) + tabs (40) +
// filters bar, PLUS the bottom "Open audit folder" footer (~34px: padding 8×2 +
// row + hairline) which renders below the list. The footer was uncounted before
// the titlebar landed too (328 had the same bug). The 42 mirrors
// --kraft-titlebar-height in index.css (keep in sync — TS can't read the CSS var).
const HEADER_AND_FILTERS_HEIGHT = 404;
// Height reclaimed from the list when the retention size banner is visible.
// Mirrors .retentionBanner in Detections.module.css: padding 10×2 + hairline +
// ~2 wrapped lines of 13px/1.5 text ≈ 60px. Erring generous (vs. a 1-line
// banner on a wide window) keeps the list from ever overflowing the footer;
// worst case is a hair of empty space, never a row hidden below it.
const RETENTION_BANNER_HEIGHT = 60;
// Rows from the end at which we prefetch the next page (infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

interface DetectionsProps {
  readonly mcpFilter: string | null;
  readonly onClearMcpFilter: () => void;
}

export function Detections({ mcpFilter, onClearMcpFilter }: DetectionsProps): JSX.Element {
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly Category[]>(CATEGORY_OPTIONS);
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  const [openDropdown, setOpenDropdown] = useState<'severity' | 'category' | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  const severityRef = useRef<HTMLDivElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(
    window.innerHeight - HEADER_AND_FILTERS_HEIGHT,
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<FixedSizeList>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastSeenTopId, setLastSeenTopId] = useState<string | null>(null);

  // The full filter is computed server-side; the renderer no longer filters.
  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: mcpFilter,
      timeRange: selectedTimeRange,
      categories: [...selectedCategories],
      severities: [...selectedSeverities],
    }),
    [mcpFilter, selectedTimeRange, selectedCategories, selectedSeverities],
  );

  const page = useDetectionPage(filter);
  const { rows, retention } = page;

  useEffect(() => {
    function onResize(): void {
      setListHeight(window.innerHeight - HEADER_AND_FILTERS_HEIGHT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (openDropdown === null) return;
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      const target = e.target as Node;
      const insideSeverity = severityRef.current?.contains(target) ?? false;
      const insideCategory = categoryRef.current?.contains(target) ?? false;
      if (!insideSeverity && !insideCategory) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [openDropdown]);

  useEffect(() => {
    if (scrollOffset === 0 && rows.length > 0) {
      const topId = rows[0]?.id ?? null;
      if (topId !== null && topId !== lastSeenTopId) {
        setLastSeenTopId(topId);
      }
    }
  }, [scrollOffset, rows, lastSeenTopId]);

  useEffect(() => {
    setLastSeenTopId(rows[0]?.id ?? null);
    setScrollOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeverities, selectedCategories, selectedTimeRange, mcpFilter]);

  const newCount = useMemo(() => {
    if (lastSeenTopId === null) return 0;
    if (scrollOffset === 0) return 0;
    const idx = rows.findIndex((d) => d.id === lastSeenTopId);
    if (idx === -1) return 0;
    return idx;
  }, [rows, lastSeenTopId, scrollOffset]);

  const hasActiveFilters =
    mcpFilter !== null ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    selectedCategories.length !== CATEGORY_OPTIONS.length ||
    selectedTimeRange !== 'all';

  const counterLabel = hasActiveFilters
    ? `${page.totalMatching} of ${page.total}`
    : `${page.total} events`;

  function handleRowClick(row: DetectionRowSlim): void {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedRow(row);
  }

  function handleDrawerClose(): void {
    setSelectedRow(null);
    const trigger = triggerRef.current;
    if (trigger !== null && document.body.contains(trigger)) {
      trigger.focus();
    }
    triggerRef.current = null;
  }

  function handleSelectTotal(): void {
    setSelectedSeverities(SEVERITY_OPTIONS);
  }

  function handleSelectSeverity(severity: Severity): void {
    setSelectedSeverities((prev) => {
      if (prev.length === 1 && prev[0] === severity) {
        return SEVERITY_OPTIONS;
      }
      return [severity];
    });
  }

  function handlePillClick(): void {
    listRef.current?.scrollTo(0);
    setLastSeenTopId(rows[0]?.id ?? null);
  }

  function handleClearFilters(): void {
    setSelectedSeverities(SEVERITY_OPTIONS);
    setSelectedCategories(CATEGORY_OPTIONS);
    setSelectedTimeRange('all');
    onClearMcpFilter();
  }

  function handleOpenAuditFolder(): void {
    void window.xcg.openAuditFolder();
  }

  const showSizeWarning =
    retention !== null && retention.totalBytes > retention.sizeWarnBytes;

  // The banner renders above the list, so shrink the list by its height when
  // shown (listHeight itself stays keyed to the window/resize only).
  const effectiveListHeight = showSizeWarning
    ? listHeight - RETENTION_BANNER_HEIGHT
    : listHeight;

  return (
    <>
      {showSizeWarning && retention !== null && (
        <div className={styles['retentionBanner']} role="status">
          xCLAUDE Gateway keeps every audit event by default — your log has grown
          to {formatBytes(retention.totalBytes)}. Open Settings to turn on
          automatic cleanup by age.
        </div>
      )}
      <SeverityBreakdown
        counts={page.severityCounts}
        total={page.categoryFilteredTotal}
        selectedSeverities={selectedSeverities}
        totalSeverityOptionsCount={SEVERITY_OPTIONS.length}
        onSelectTotal={handleSelectTotal}
        onSelectSeverity={handleSelectSeverity}
      />
      <div className={styles['filters']}>
        {mcpFilter !== null && (
          <span className={styles['connectorFilter']}>
            <span className={styles['connectorFilterLabel']}>connector</span>
            {mcpFilter}
            <button
              type="button"
              className={styles['connectorFilterClear']}
              onClick={onClearMcpFilter}
              aria-label={`Clear connector filter: ${mcpFilter}`}
            >
              ✕
            </button>
          </span>
        )}
        <span className={styles['smartCounter']}>{counterLabel}</span>
        <FilterDropdown
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={selectedSeverities}
          onChange={setSelectedSeverities}
          isOpen={openDropdown === 'severity'}
          onToggle={() => setOpenDropdown((prev) => (prev === 'severity' ? null : 'severity'))}
          dropdownRef={severityRef}
        />
        <FilterDropdown
          label="Category"
          options={CATEGORY_OPTIONS}
          selected={selectedCategories}
          onChange={setSelectedCategories}
          isOpen={openDropdown === 'category'}
          onToggle={() => setOpenDropdown((prev) => (prev === 'category' ? null : 'category'))}
          dropdownRef={categoryRef}
        />
        <div className={styles['timeFilterSpacer']}>
          <TimeFilter value={selectedTimeRange} onChange={setSelectedTimeRange} />
        </div>
      </div>
      {rows.length === 0 ? (
        hasActiveFilters ? (
          <div className={styles['emptyFiltered']}>
            <h2 className={styles['emptyFilteredHeading']}>No matches with current filters</h2>
            <p className={styles['emptyFilteredSubhead']}>
              Try widening the time range or adding more severities.
            </p>
            <button
              type="button"
              className={styles['clearFiltersButton']}
              onClick={handleClearFilters}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className={styles['empty']}>
            No detections yet. Wrap an MCP server with xcg-proxy to start auditing.
          </div>
        )
      ) : (
        <div className={styles['listContainer']}>
          <div className={styles['columnHeader']}>
            <span className={styles['columnHeaderCell']}>Time</span>
            <span className={styles['columnHeaderCell']}>Severity</span>
            <span className={styles['columnHeaderCell']}>Category</span>
            <span className={styles['columnHeaderCell']}>Mcp</span>
            <span className={styles['columnHeaderCell']}>Tool</span>
          </div>
          <FixedSizeList
            ref={listRef}
            height={effectiveListHeight}
            width="100%"
            itemSize={ROW_HEIGHT}
            itemCount={rows.length}
            itemKey={(index) => rows[index]?.id ?? index}
            onScroll={({ scrollOffset: offset }) => setScrollOffset(offset)}
            onItemsRendered={({ visibleStopIndex }) => {
              if (page.hasMore && visibleStopIndex >= rows.length - LOAD_MORE_THRESHOLD) {
                page.loadMore();
              }
            }}
          >
            {({ index, style }) => {
              const item = rows[index];
              if (item === undefined) return null;
              return (
                <div style={style}>
                  <DetectionRow
                    row={item}
                    selected={selectedRow?.id === item.id}
                    onClick={() => handleRowClick(item)}
                  />
                </div>
              );
            }}
          </FixedSizeList>
          {newCount > 0 && (
            <NewEventsPill count={newCount} onClick={handlePillClick} />
          )}
        </div>
      )}
      {selectedRow !== null && (
        <DetailDrawer row={selectedRow} onClose={handleDrawerClose} />
      )}
      <div className={styles['footer']}>
        <button
          type="button"
          className={styles['footerLink']}
          onClick={handleOpenAuditFolder}
          disabled={page.total === 0}
        >
          Open audit folder <span aria-hidden="true">↗</span>
        </button>
      </div>
    </>
  );
}
