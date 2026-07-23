import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import type {
  DetectionFilter,
  DetectionRowSlim,
  Severity,
  Category,
  SourceKind,
} from '../../shared/types.js';
import { SOURCE_LABELS } from './detections-format.js';

import { AuditFooter } from './AuditFooter.js';
import { DetailDrawer } from './DetailDrawer.js';
import { DetectionRow } from './DetectionRow.js';
import { FilterDropdown } from './FilterDropdown.js';
import { NewEventsPill } from './NewEventsPill.js';
import { SeverityBreakdown } from './SeverityBreakdown.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';

import styles from './Detections.module.css';
// The whole toolbar band (toolbar/toolbarRow/chipsRow) plus the
// search/date-input skins live in ClaudeCode.module.css — since the toolbar
// parity (dogfood 22/07) Detections renders CC's exact multi-row band.
// Commit 5f's anti-drift pattern in the opposite direction (one physical
// rule, zero drift); CSS-module import only: no TSX cycle (ClaudeCode.tsx
// imports constants from this file).
import ccStyles from './ClaudeCode.module.css';

// Exported (like CATEGORY_OPTIONS below) so sibling views that fix a filter
// axis (ClaudeCode) share the same "everything selected" definition.
export const SEVERITY_OPTIONS: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const SOURCE_OPTIONS: readonly SourceKind[] = ['gateway', 'claude-code'];
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

// Search debounce: fast enough to feel live, slow enough to not thrash the
// 2s-polled IPC with every keystroke. Exported (filter parity 22/07): both
// views share the same cadence, like the option inventories above.
export const SEARCH_DEBOUNCE_MS = 250;

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
// the TWO-ROW toolbar (~92 MEASURED via CDP, dogfood 3ª ronda: padding 12×2 +
// row1 29.5 + gap 14 + row2 23.5 = 91 — CC's band, shared since the toolbar
// parity 22/07; the custom date inputs ride INSIDE row 2, no extra height),
// PLUS the bottom "Open audit folder" footer (~34px: padding 8×2 + row +
// hairline) which renders below the list. The 42 mirrors
// --kraft-titlebar-height in index.css (keep in sync — TS can't read the CSS
// var).
// Exported (commit 5h): ClaudeCode shares this constant — both views have the
// IDENTICAL chrome stack, toolbar included since the parity. A view-local
// estimate drifting low overflows 100vh and flex-shrink compresses the
// titlebar (the drag strip visibly narrows).
export const HEADER_AND_FILTERS_HEIGHT = 440;
// Height reclaimed from the list when the retention size banner is visible.
// Mirrors .retentionBanner in Detections.module.css: padding 10×2 + hairline +
// ~2 wrapped lines of 13px/1.5 text ≈ 60px. Erring generous (vs. a 1-line
// banner on a wide window) keeps the list from ever overflowing the footer;
// worst case is a hair of empty space, never a row hidden below it.
const RETENTION_BANNER_HEIGHT = 60;
// (CUSTOM_ROW_HEIGHT died in dogfood 3ª ronda: the custom date inputs live
// inside the chips row now, so the Custom segment adds no extra height.)
// Rows from the end at which we prefetch the next page (infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

interface DetectionsProps {
  readonly mcpFilter: string | null;
  readonly onClearMcpFilter: () => void;
  /** One-shot source-filter preset (Claude Code inspector's Open in
   *  Detections). Applied to the internal sources selection on arrival, then
   *  acknowledged via onSourcesPresetConsumed — the selection itself stays
   *  owned by this component (unlike the controlled mcpFilter). */
  readonly sourcesPreset?: readonly SourceKind[] | null;
  readonly onSourcesPresetConsumed?: () => void;
}

export function Detections({ mcpFilter, onClearMcpFilter, sourcesPreset = null, onSourcesPresetConsumed }: DetectionsProps): JSX.Element {
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly Category[]>(CATEGORY_OPTIONS);
  const [selectedSources, setSelectedSources] =
    useState<readonly SourceKind[]>(SOURCE_OPTIONS);
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  const [openDropdown, setOpenDropdown] = useState<'severity' | 'category' | 'source' | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  // Free-text search (filter parity 22/07 — ClaudeCode's exact pattern): raw
  // input debounced into the shipped filter value.
  const [searchInput, setSearchInput] = useState('');
  const [textFilter, setTextFilter] = useState<string | null>(null);
  // Custom date range (active when the time segment is 'custom').
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const severityRef = useRef<HTMLDivElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(
    window.innerHeight - HEADER_AND_FILTERS_HEIGHT,
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<FixedSizeList>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastSeenTopId, setLastSeenTopId] = useState<string | null>(null);

  // Debounce the search box into the shipped text filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      setTextFilter(trimmed === '' ? null : trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // The full filter is computed server-side; the renderer no longer filters.
  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: mcpFilter,
      timeRange: selectedTimeRange,
      categories: [...selectedCategories],
      severities: [...selectedSeverities],
      sources: [...selectedSources],
      text: textFilter,
      customRange:
        selectedTimeRange === 'custom' && customFrom !== '' && customTo !== ''
          ? { from: customFrom, to: customTo }
          : null,
    }),
    [
      mcpFilter, selectedTimeRange, selectedCategories, selectedSeverities,
      selectedSources, textFilter, customFrom, customTo,
    ],
  );

  const page = useDetectionPage(filter);
  const { rows, retention } = page;

  // Apply the one-shot preset and hand the token back immediately, so a later
  // manual change to the pill is never fought by a stale preset.
  useEffect(() => {
    if (sourcesPreset === null) return;
    setSelectedSources(sourcesPreset);
    onSourcesPresetConsumed?.();
  }, [sourcesPreset, onSourcesPresetConsumed]);

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
      const insideSource = sourceRef.current?.contains(target) ?? false;
      if (!insideSeverity && !insideCategory && !insideSource) {
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
    // (The export-result reset on filter change lives in AuditFooter now.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeverities, selectedCategories, selectedSources, selectedTimeRange, mcpFilter, textFilter, customFrom, customTo]);

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
    selectedSources.length !== SOURCE_OPTIONS.length ||
    // 'custom' is covered here too — any non-default time segment is active.
    selectedTimeRange !== 'all' ||
    textFilter !== null;

  // (The "N events" toolbar counter was removed in F2.4 commit 5i — the
  // Total severity card already carries that number.)

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
    setSelectedSources(SOURCE_OPTIONS);
    setSelectedTimeRange('all');
    setSearchInput('');
    setTextFilter(null); // immediate — don't wait out the debounce
    setCustomFrom('');
    setCustomTo('');
    onClearMcpFilter();
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
      <div className={ccStyles['toolbar']}>
        <div className={ccStyles['toolbarRow']}>
          <input
            type="search"
            className={ccStyles['searchBox']}
            placeholder="Search tool or details…"
            aria-label="Search tool or details"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <div className={styles['timeFilterSpacer']}>
            <TimeFilter
              value={selectedTimeRange}
              onChange={setSelectedTimeRange}
              allowCustom
            />
          </div>
        </div>
        <div className={`${ccStyles['toolbarRow']} ${ccStyles['chipsRow']}`}>
          {mcpFilter !== null && (
            <span className={styles['connectorFilter']}>
              <span className={styles['connectorFilterLabel']}>MCP</span>
              {mcpFilter}
              <button
                type="button"
                className={styles['connectorFilterClear']}
                onClick={onClearMcpFilter}
                aria-label={`Clear MCP filter: ${mcpFilter}`}
              >
                ✕
              </button>
            </span>
          )}
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
          <FilterDropdown
            label="Source"
            options={SOURCE_OPTIONS}
            selected={selectedSources}
            onChange={setSelectedSources}
            isOpen={openDropdown === 'source'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'source' ? null : 'source'))}
            dropdownRef={sourceRef}
            formatOption={(o) => SOURCE_LABELS[o]}
          />
          {hasActiveFilters && (
            // Always-reachable reset (producto 22/07): same handler as the
            // filtered-empty state's button, which stays — this one is the
            // discovery-level affordance while results are still visible.
            <button
              type="button"
              className={ccStyles['clearInline']}
              onClick={handleClearFilters}
            >
              Clear filters
            </button>
          )}
          {selectedTimeRange === 'custom' && (
            // Native date inputs — CC's exact pattern: IN the chips row
            // (dogfood 3ª ronda), right-aligned under the time segment; on a
            // narrow window they wrap as a whole unit like any chip.
            <span className={ccStyles['customRange']}>
              <input
                type="date"
                className={ccStyles['dateInput']}
                aria-label="From date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span className={ccStyles['customRangeSep']}>–</span>
              <input
                type="date"
                className={ccStyles['dateInput']}
                aria-label="To date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </span>
          )}
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
            No detections yet. Route a source through xCLAUDE to start auditing.
          </div>
        )
      ) : (
        <div className={styles['listContainer']}>
          <div className={styles['columnHeader']}>
            <span className={styles['columnHeaderCell']}>Time</span>
            <span className={styles['columnHeaderCell']}>Severity</span>
            <span className={styles['columnHeaderCell']}>Category</span>
            <span className={styles['columnHeaderCell']}>MCP</span>
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
      <AuditFooter filter={filter} total={page.total} totalMatching={page.totalMatching} />
    </>
  );
}
