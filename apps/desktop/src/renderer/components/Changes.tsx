// The Changes tab: connector surface changes, as a sibling of Detections and
// Claude Code rather than a screen of its own.
//
// Everything structural is the shared piece the other two use — the five
// counter cards, the search box and time segments, the filter chips, the
// column header, the virtualized list, the detail drawer and the footer. What
// is new is only what this tab counts and what its rows say.
//
// The card row is the one deliberate departure: CRITICAL is replaced by NEEDS
// REVIEW. No rule produces critical for a manifest change, so that card would
// sit at zero forever, while the question this tab exists to answer had
// nowhere to appear. The slot is kept so the row stays a shape the eye
// recognises from the other two tabs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import type { Severity } from '../../shared/types.js';
import type { ConnectorChangeView } from '../lib/xcgApi.js';
import {
  needsReview,
  topSeverity,
  useChangePage,
  type ChangeFilter,
  type ReviewState,
} from '../hooks/useChangePage.js';
import { useListView } from '../hooks/useListView.js';
import { AuditFooter } from './AuditFooter.js';
import { ChangeRow } from './ChangeRow.js';
import { ColumnHeader, columnsStyle, type Column } from './ColumnHeader.js';
import { DetailDrawer } from './DetailDrawer.js';
import { FilterDropdown } from './FilterDropdown.js';
import { SEVERITY_OPTIONS } from './Detections.js';
import { SeverityBreakdown, type BreakdownCard } from './SeverityBreakdown.js';
import { SECTION_LABELS } from './change-copy.js';
import { TimeFilter } from './TimeFilter.js';
import { ToggleChip } from './ToggleChip.js';
import { DateRangePicker } from './DateRangePicker.js';

// The toolbar band comes from ClaudeCode.module.css and the list container
// from Detections.module.css — the same split Detections itself uses, so the
// three tabs share one physical rule per element rather than three copies.
import styles from './Detections.module.css';
import bar from './ClaudeCode.module.css';

const ROW_HEIGHT = 40;

export const CHANGE_COLUMNS: readonly Column[] = [
  { key: 'time', label: 'Time', width: '130px' },
  { key: 'severity', label: 'Severity', width: '90px' },
  { key: 'change', label: 'Change', width: '200px' },
  { key: 'mcp', label: 'MCP', width: '150px' },
  { key: 'details', label: 'Details', width: '1fr' },
];

const REVIEW_OPTIONS: readonly ReviewState[] = ['unreviewed', 'reviewed'];
const REVIEW_LABELS: Record<string, string> = { unreviewed: 'Unreviewed', reviewed: 'Reviewed' };

export function Changes(): JSX.Element {
  const view = useListView<'severity' | 'status' | 'section' | 'mcp'>();
  const {
    searchInput,
    setSearchInput,
    textFilter,
    timeRange,
    setTimeRange,
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
    setHasRows,
  } = view;

  // Needs review is ON by default: the tab opens on the question it exists to
  // answer, not on four months of vendor edits.
  const [needsReviewOnly, setNeedsReviewOnly] = useState(true);
  const [withFindingsOnly, setWithFindingsOnly] = useState(false);
  const [selectedSeverities, setSelectedSeverities] = useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [reviewFilter, setReviewFilter] = useState<readonly ReviewState[]>(REVIEW_OPTIONS);
  const [sectionFilter, setSectionFilter] = useState<readonly ConnectorChangeView['section'][] | null>(null);
  const [mcpFilter, setMcpFilter] = useState<readonly string[] | null>(null);
  const [selectedRow, setSelectedRow] = useState<ConnectorChangeView | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const filter: ChangeFilter = useMemo(
    () => ({
      needsReviewOnly,
      withFindingsOnly,
      severities: selectedSeverities,
      review: reviewFilter.length === REVIEW_OPTIONS.length ? [] : reviewFilter,
      sections: sectionFilter ?? [],
      mcps: mcpFilter ?? [],
      text: textFilter,
      timeRange,
      customRange: customRange ?? null,
    }),
    [needsReviewOnly, withFindingsOnly, selectedSeverities, reviewFilter, sectionFilter, mcpFilter, textFilter, timeRange, customRange],
  );

  const page = useChangePage(filter);
  const rows = page.rows;
  // The viewport only exists while there are rows, so the height measurement
  // has to re-run when that flips. In an effect, never during render.
  const hasRows = rows.length > 0;
  useEffect(() => {
    setHasRows(hasRows);
  }, [setHasRows, hasRows]);

  const cards: BreakdownCard[] = useMemo(() => {
    const allSeverities = selectedSeverities.length === SEVERITY_OPTIONS.length;
    const noCardFilter = allSeverities && !needsReviewOnly && !withFindingsOnly;
    const soleSeverity = (sev: Severity): boolean =>
      !needsReviewOnly &&
      !withFindingsOnly &&
      !allSeverities &&
      selectedSeverities.length === 1 &&
      selectedSeverities[0] === sev;
    const clearThen = (fn: () => void) => (): void => {
      setSelectedSeverities(SEVERITY_OPTIONS);
      setNeedsReviewOnly(false);
      setWithFindingsOnly(false);
      fn();
    };
    return [
      {
        key: 'total',
        label: 'Total',
        count: page.total,
        active: noCardFilter,
        inactive: !noCardFilter,
        onSelect: clearThen(() => undefined),
      },
      {
        // Neutral, like TOTAL: "carries a finding" is a fact about the set,
        // not a severity, and colouring it would imply one.
        key: 'withfindings',
        label: 'With findings',
        count: page.withFindingsCount,
        active: withFindingsOnly,
        inactive: !withFindingsOnly && !noCardFilter,
        onSelect: clearThen(() => setWithFindingsOnly(true)),
      },
      ...(['medium', 'high'] as const).map((sev) => ({
        key: sev,
        label: sev[0]!.toUpperCase() + sev.slice(1),
        count: page.severityCounts[sev],
        active: soleSeverity(sev),
        inactive: !noCardFilter && !soleSeverity(sev),
        onSelect: clearThen(() => setSelectedSeverities([sev])),
      })),
      {
        // The question the tab exists to answer. Prominent but NOT coloured:
        // a severity tint here would claim a risk level the set does not have —
        // half of what lands in it carries no finding at all.
        key: 'needsreview',
        label: 'Needs review',
        count: page.needsReviewCount,
        active: needsReviewOnly,
        inactive: !needsReviewOnly && !noCardFilter,
        onSelect: clearThen(() => setNeedsReviewOnly(true)),
      },
    ];
  }, [
    page.total,
    page.withFindingsCount,
    page.severityCounts,
    page.needsReviewCount,
    selectedSeverities,
    needsReviewOnly,
    withFindingsOnly,
  ]);

  const hasActiveFilters =
    needsReviewOnly ||
    withFindingsOnly ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    reviewFilter.length !== REVIEW_OPTIONS.length ||
    sectionFilter !== null ||
    mcpFilter !== null ||
    searchInput !== '' ||
    timeRange !== 'all';

  function handleClearFilters(): void {
    setNeedsReviewOnly(false);
    setWithFindingsOnly(false);
    setSelectedSeverities(SEVERITY_OPTIONS);
    setReviewFilter(REVIEW_OPTIONS);
    setSectionFilter(null);
    setMcpFilter(null);
    view.resetShared();
  }

  const handleReview = useCallback(
    (row: ConnectorChangeView) => {
      const to = row.review_status === 'reviewed' ? 'unreviewed' : 'reviewed';
      const write = window.xcg.setReviewStatus?.(row.event_id, to);
      // Re-read rather than patch in place: the folded status has to come back
      // from the trail, not from what this component hoped happened.
      if (write === undefined) return;
      void write.then(() => {
        page.refresh();
        setSelectedRow((prev) => (prev === null ? null : { ...prev, review_status: to }));
      });
    },
    [page],
  );

  const handleExport = useCallback(async () => {
    const run = window.xcg.exportChanges?.(rows.map((r) => r.event_id));
    if (run === undefined) return null;
    const result = await run;
    if (result.ok) return { ok: true as const, count: result.count };
    if ('error' in result) return { ok: false as const, error: result.error };
    return null; // cancelled
  }, [rows]);

  return (
    <>
      <SeverityBreakdown cards={cards} />
      <div className={bar['toolbar']}>
        <div className={bar['toolbarRow']}>
          <input
            type="search"
            className={bar['searchBox']}
            placeholder="Search tools, resources, rules…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <div className={styles['timeFilterSpacer']}>
            <TimeFilter value={timeRange} onChange={setTimeRange} allowCustom />
          </div>
        </div>
        <div className={`${bar['toolbarRow']} ${bar['chipsRow']}`}>
          <ToggleChip
            label="Needs review only"
            tooltip="Show only changes that raised a rule or a review recommendation and have not been reviewed"
            active={needsReviewOnly}
            onChange={setNeedsReviewOnly}
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
            label="Status"
            options={REVIEW_OPTIONS}
            selected={reviewFilter}
            onChange={setReviewFilter}
            isOpen={openDropdown === 'status'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'status' ? null : 'status'))}
            dropdownRef={dropdownRef('status')}
            formatOption={(o) => REVIEW_LABELS[o] ?? o}
          />
          <FilterDropdown
            label="Section"
            options={page.facets.sections}
            selected={sectionFilter ?? page.facets.sections}
            onChange={(next) =>
              setSectionFilter(next.length === page.facets.sections.length ? null : next)
            }
            isOpen={openDropdown === 'section'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'section' ? null : 'section'))}
            dropdownRef={dropdownRef('section')}
            formatOption={(o) => SECTION_LABELS[o] ?? o}
          />
          <FilterDropdown
            label="MCP"
            options={page.facets.mcps}
            selected={mcpFilter ?? page.facets.mcps}
            onChange={(next) => setMcpFilter(next.length === page.facets.mcps.length ? null : next)}
            isOpen={openDropdown === 'mcp'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'mcp' ? null : 'mcp'))}
            dropdownRef={dropdownRef('mcp')}
          />
          {hasActiveFilters && (
            <button type="button" className={bar['clearInline']} onClick={handleClearFilters}>
              Clear filters
            </button>
          )}
        </div>
        {timeRange === 'custom' && (
          <div className={bar['toolbarRow']}>
            <DateRangePicker
              from={customFrom}
              to={customTo}
              onChange={(f, t) => {
                setCustomFrom(f);
                setCustomTo(t);
              }}
            />
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className={styles['empty']}>
          {page.loading
            ? 'Loading changes…'
            : needsReviewOnly
              ? 'Nothing needs review. Every change a rule flagged has been looked at.'
              : hasActiveFilters
                ? 'No change matches these filters.'
                : 'No connector changes recorded yet.'}
        </div>
      ) : (
        <div className={styles['listContainer']} style={columnsStyle(CHANGE_COLUMNS)}>
          <ColumnHeader columns={CHANGE_COLUMNS} />
          <div className={styles['listViewport']} ref={listViewportRef}>
            <FixedSizeList
              height={listHeight}
              width="100%"
              itemSize={ROW_HEIGHT}
              itemCount={rows.length}
              itemKey={(index) => rows[index]?.event_id ?? index}
            >
              {({ index, style }) => {
                const row = rows[index];
                if (row === undefined) return null;
                return (
                  <div style={style}>
                    <ChangeRow
                      row={row}
                      selected={selectedRow?.event_id === row.event_id}
                      onClick={() => {
                        triggerRef.current = document.activeElement as HTMLElement | null;
                        setSelectedRow(row);
                      }}
                    />
                  </div>
                );
              }}
            </FixedSizeList>
          </div>
        </div>
      )}

      <DetailDrawer
        change={selectedRow}
        onReview={handleReview}
        onClose={() => {
          setSelectedRow(null);
          triggerRef.current?.focus();
        }}
      />
      <AuditFooter
        filter={{
          mcp: null,
          timeRange: 'all',
          categories: [],
          severities: [],
          sources: [],
        }}
        total={page.total}
        totalMatching={page.totalMatching}
        noun="change"
        onExport={handleExport}
      />
    </>
  );
}

// Re-exported for the tab bar and tests.
export { needsReview, topSeverity };
