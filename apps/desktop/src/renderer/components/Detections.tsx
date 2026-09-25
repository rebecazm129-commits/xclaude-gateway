import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import { useListView } from '../hooks/useListView.js';
import type {
  DetectionFilter,
  DetectionRowSlim,
  Severity,
  Category,
  SourceKind,
} from '../../shared/types.js';

import { sourceLabel } from '../../shared/tool-names.js';
import { AuditFooter } from './AuditFooter.js';
import { ColumnHeader, DETECTION_COLUMNS, columnsStyle } from './ColumnHeader.js';
import { DateRangePicker } from './DateRangePicker.js';
import { DetailDrawer } from './DetailDrawer.js';
import { facetChange, facetOptions } from './facet-select.js';
import { DetectionRow } from './DetectionRow.js';
import { FilterDropdown } from './FilterDropdown.js';
import { NewEventsPill } from './NewEventsPill.js';
import { SeverityBreakdown, severityCards } from './SeverityBreakdown.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';
import { ToggleChip } from './ToggleChip.js';

import styles from './Detections.module.css';
// The whole toolbar band (toolbar/toolbarRow/chipsRow) plus the
// search-box skin live in ClaudeCode.module.css — since the toolbar
// parity (dogfood 22/07) Detections renders CC's exact multi-row band.
// Commit 5f's anti-drift pattern in the opposite direction (one physical
// rule, zero drift); CSS-module import only: no TSX cycle (ClaudeCode.tsx
// imports constants from this file).
import ccStyles from './ClaudeCode.module.css';

// Exported (like CATEGORY_OPTIONS below) so sibling views that fix a filter
// axis (ClaudeCode) share the same "everything selected" definition.
export const SEVERITY_OPTIONS: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
// Both record kinds, always: the Source chip filters by concrete source (see
// sourceName), so the SourceKind axis is never narrowed in this view.
const SOURCE_OPTIONS: readonly SourceKind[] = ['gateway', 'claude-code'];
// Exported so the default-filter membership is unit-testable. The filter is
// server-side, so a category absent here is filtered OUT by default.
// tool_manifest_changed is NOT here, and its absence is what keeps manifest
// changes out of this view: the filter ships `categories`, and a category no
// option lists can never be selected, so those events — historical ones
// included — never match. They live in MCP changes, where a change with no
// finding is a fact rather than a row graded medium so it could be seen at
// all. Seven options remain: six risk categories plus tool_call_allowed.
export const CATEGORY_OPTIONS: readonly Category[] = [
  'credential_detected',
  'prompt_injection',
  'email_send_warning',
  'data_export_warning',
  'tool_call_allowed',
  'pii_detected',
  'pii_structured',
];

// Flagged = everything the detectors actually flagged: every category except
// the baseline tool_call_allowed. Server-side (categories axis), so counts
// never lie. Shared by both views' "Flagged only" chip.
export const FLAGGED_CATEGORIES: readonly Category[] = CATEGORY_OPTIONS.filter(
  (c) => c !== 'tool_call_allowed',
);

// Search debounce: fast enough to feel live, slow enough to not thrash the
// 2s-polled IPC with every keystroke. Exported (filter parity 22/07): both

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
// Pre-measure fallback for the virtualized list height. The real value is
// MEASURED from .listViewport by a layout effect before the first paint and
// kept true by a ResizeObserver (see the effect in the component) — never
// derived from window.innerHeight minus a chrome constant again: any sibling
// the constant didn't know about (an app-level banner, the retention banner)
// made the fixed sum overflow 100vh and flex-shrink compressed the titlebar.
// This fallback is only ever painted in layout-less environments (jsdom
// reports clientHeight 0, which the measure ignores).
// Exported (commit 5h precedent): ClaudeCode shares the same measuring
// (CUSTOM_ROW_HEIGHT died in dogfood 3ª ronda: the custom date inputs live
// inside the chips row now, so the Custom segment adds no extra height.)
// Rows from the end at which we prefetch the next page (infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

interface DetectionsProps {
  readonly mcpFilter: string | null;
  readonly onClearMcpFilter: () => void;
  /** One-shot Source-chip preset, as concrete source names (Claude Code
   *  inspector's Open in Detections sends ['claude-code']). Applied to the
   *  internal selection on arrival, then acknowledged via
   *  onSourcesPresetConsumed — the selection itself stays owned by this
   *  component (unlike the controlled mcpFilter). */
  readonly sourcesPreset?: readonly string[] | null;
  readonly onSourcesPresetConsumed?: () => void;
}

export function Detections({ mcpFilter, onClearMcpFilter, sourcesPreset = null, onSourcesPresetConsumed }: DetectionsProps): JSX.Element {
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly Category[]>(CATEGORY_OPTIONS);
  // null = every source, whatever the inventory holds right now. A stored list
  // would silently exclude a connector added after it was made.
  const [selectedSourceNames, setSelectedSourceNames] = useState<readonly string[] | null>(null);
  // OFF by default: this view is the audit trail, and activity that matched
  // nothing is part of it. The chip is the one-click way to the findings.
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  // Search, time range, measured height and the open dropdown are the same in
  // every audit list view — see hooks/useListView.ts.
  const view = useListView<'severity' | 'category' | 'source'>();
  const {
    searchInput,
    setSearchInput,
    textFilter,
    timeRange: selectedTimeRange,
    setTimeRange: setSelectedTimeRange,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    customRange,
    openDropdown,
    setOpenDropdown,
    dropdownRef,
    listHeight,
    listViewportRef,
  } = view;
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<FixedSizeList>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastSeenTopId, setLastSeenTopId] = useState<string | null>(null);

  // The full filter is computed server-side; the renderer no longer filters.
  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: mcpFilter,
      timeRange: selectedTimeRange,
      // Flagged only narrows whatever the Category chip holds rather than
      // replacing it, so the two compose instead of fighting.
      categories: flaggedOnly
        ? selectedCategories.filter((c) => c !== 'tool_call_allowed')
        : [...selectedCategories],
      severities: [...selectedSeverities],
      sources: [...SOURCE_OPTIONS],
      sourceNames: selectedSourceNames === null ? null : [...selectedSourceNames],
      text: textFilter,
      customRange: customRange ?? null,
    }),
    [
      mcpFilter, selectedTimeRange, selectedCategories, flaggedOnly, selectedSeverities,
      selectedSourceNames, textFilter, customFrom, customTo,
    ],
  );

  const page = useDetectionPage(filter);
  const { rows, retention } = page;
  const sourceOptions = useMemo(
    () => facetOptions(page.facets.sourceNames, selectedSourceNames),
    [page.facets.sourceNames, selectedSourceNames],
  );

  // Apply the one-shot preset and hand the token back immediately, so a later
  // manual change to the pill is never fought by a stale preset.
  useEffect(() => {
    if (sourcesPreset === null) return;
    setSelectedSourceNames(sourcesPreset);
    onSourcesPresetConsumed?.();
  }, [sourcesPreset, onSourcesPresetConsumed]);

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
  }, [selectedSeverities, selectedCategories, flaggedOnly, selectedSourceNames, selectedTimeRange, mcpFilter, textFilter, customFrom, customTo]);

  // The viewport only exists while there are rows, so the height measurement
  // has to re-run when that flips.
  const hasRows = rows.length > 0;
  useEffect(() => {
    view.setHasRows(hasRows);
  }, [view, hasRows]);

  const newCount = useMemo(() => {
    if (lastSeenTopId === null) return 0;
    if (scrollOffset === 0) return 0;
    const idx = rows.findIndex((d) => d.id === lastSeenTopId);
    if (idx === -1) return 0;
    return idx;
  }, [rows, lastSeenTopId, scrollOffset]);

  const hasActiveFilters =
    mcpFilter !== null ||
    flaggedOnly ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    selectedCategories.length !== CATEGORY_OPTIONS.length ||
    selectedSourceNames !== null ||
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
    setFlaggedOnly(false);
    setSelectedSeverities(SEVERITY_OPTIONS);
    setSelectedCategories(CATEGORY_OPTIONS);
    setSelectedSourceNames(null);
    view.resetShared();
    onClearMcpFilter();
  }

  const showSizeWarning =
    retention !== null && retention.totalBytes > retention.sizeWarnBytes;

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
        cards={severityCards({
          counts: page.severityCounts,
          total: page.categoryFilteredTotal,
          selectedSeverities,
          totalSeverityOptionsCount: SEVERITY_OPTIONS.length,
          onSelectTotal: handleSelectTotal,
          onSelectSeverity: handleSelectSeverity,
        })}
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
          <ToggleChip
            label="Flagged only"
            tooltip="Show only calls that triggered a detection"
            active={flaggedOnly}
            onChange={setFlaggedOnly}
          />
          <FilterDropdown
            label="Severity"
            options={SEVERITY_OPTIONS}
            selected={selectedSeverities}
            onChange={setSelectedSeverities}
            isOpen={openDropdown === 'severity'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'severity' ? null : 'severity'))}
            dropdownRef={dropdownRef('severity')}
          />
          <FilterDropdown
            label="Category"
            options={CATEGORY_OPTIONS}
            selected={selectedCategories}
            onChange={setSelectedCategories}
            isOpen={openDropdown === 'category'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'category' ? null : 'category'))}
            dropdownRef={dropdownRef('category')}
          />
          <FilterDropdown
            label="Source"
            options={sourceOptions}
            selected={selectedSourceNames ?? sourceOptions}
            onChange={(next) => facetChange(next, sourceOptions, setSelectedSourceNames)}
            isOpen={openDropdown === 'source'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'source' ? null : 'source'))}
            dropdownRef={dropdownRef('source')}
            formatOption={sourceLabel}
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
            // DateRangePicker (replaces the native date inputs) — CC's exact
            // pattern: IN the chips row, keeping the old .customRange spot
            // (right-aligned at the end, whole-unit wrap on narrow windows).
            // The view stays the owner of customFrom/customTo.
            <DateRangePicker
              from={customFrom}
              to={customTo}
              onChange={(f, t) => {
                setCustomFrom(f);
                setCustomTo(t);
              }}
            />
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
        <div className={styles['listContainer']} style={columnsStyle(DETECTION_COLUMNS)}>
          <ColumnHeader columns={DETECTION_COLUMNS} />
          <div className={styles['listViewport']} ref={listViewportRef}>
            <FixedSizeList
              ref={listRef}
              height={listHeight}
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
          </div>
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
