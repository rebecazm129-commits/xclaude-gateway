// The Changes tab: connector surface changes, as a sibling of Detections and
// Claude Code rather than a screen of its own.
//
// Everything structural is the shared piece the other two use — the five
// counter cards, the search box and time segments, the filter chips, the
// column header, the virtualized list, the detail drawer and the footer. What
// is new is only what this tab counts and what its rows say.
//
// The card row is the one deliberate departure: NEEDS REVIEW · HIGH · MEDIUM ·
// ALL CHANGES. The question this tab exists to answer comes first; CRITICAL and
// LOW are gone because no rule produces critical for a manifest change, and
// low is not what a change with no finding is.
//
// Changes recorded by the previous format are out of every count and list by
// default: "Previous format" is a Status option, unchecked. They are NOT marked
// reviewed to get them out of the way — nobody reviewed them — and they stay
// in the trail and in the export.

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

// CHANGE carries the title and must fit the longest one at 1100px ("Sign-in
// recorded (reference reset)", "Existing tool definition flagged"); DETAILS
// is the elastic column and may truncate.
export const CHANGE_COLUMNS: readonly Column[] = [
  { key: 'time', label: 'Time', width: '130px' },
  { key: 'severity', label: 'Severity', width: '90px' },
  { key: 'change', label: 'Change', width: '260px' },
  { key: 'mcp', label: 'MCP', width: '130px' },
  { key: 'details', label: 'Details', width: '1fr' },
];

// Status: the review state of a current-format change, plus "Previous format"
// for the changes recorded before rules and review existed — they have no
// review state to filter on, so they are their own option. Unchecked by
// default.
type StatusOption = ReviewState | 'previous';
const STATUS_OPTIONS: readonly StatusOption[] = ['unreviewed', 'reviewed', 'previous'];
const STATUS_DEFAULT: readonly StatusOption[] = ['unreviewed', 'reviewed'];
const STATUS_LABELS: Record<StatusOption, string> = {
  unreviewed: 'Unreviewed',
  reviewed: 'Reviewed',
  previous: 'Previous format',
};

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
  const [selectedSeverities, setSelectedSeverities] = useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [statusFilter, setStatusFilter] = useState<readonly StatusOption[]>(STATUS_DEFAULT);
  const includeHistorical = statusFilter.includes('previous');
  const reviewStates = statusFilter.filter((o): o is ReviewState => o !== 'previous');
  const [sectionFilter, setSectionFilter] = useState<readonly ConnectorChangeView['section'][] | null>(null);
  const [mcpFilter, setMcpFilter] = useState<readonly string[] | null>(null);
  const [selectedRow, setSelectedRow] = useState<ConnectorChangeView | null>(null);
  // The change whose review status is being written, and a failed write's
  // notice. Both belong to the panel of that change.
  const [reviewPending, setReviewPending] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const filter: ChangeFilter = useMemo(
    () => ({
      needsReviewOnly,
      includeHistorical,
      includeCurrent: reviewStates.length > 0,
      severities: selectedSeverities,
      // Both review states = no review filter; the current format is then
      // in or out as a whole through includeCurrent.
      review: reviewStates.length === 2 ? [] : reviewStates,
      sections: sectionFilter ?? [],
      mcps: mcpFilter ?? [],
      text: textFilter,
      timeRange,
      customRange: customRange ?? null,
    }),
    [needsReviewOnly, statusFilter, selectedSeverities, sectionFilter, mcpFilter, textFilter, timeRange, customRange],
  );

  const page = useChangePage(filter);
  const rows = page.rows;
  // The viewport only exists while there are rows, so the height measurement
  // has to re-run when that flips. In an effect, never during render.
  const hasRows = rows.length > 0;
  useEffect(() => {
    setHasRows(hasRows);
  }, [setHasRows, hasRows]);

  // Which card the user PRESSED, if any. The default view's filter comes from
  // the "Needs review only" chip, not from a card, so opening the tab dims
  // nothing — a card dims the others only once it has been pressed, as in
  // Detections. A pressed card stops counting as pressed the moment the
  // filter it set is changed by other means (the chip, the Severity chip).
  const [pressedCard, setPressedCard] = useState<'needsreview' | 'medium' | 'high' | null>(null);

  const cards: BreakdownCard[] = useMemo(() => {
    const allSeverities = selectedSeverities.length === SEVERITY_OPTIONS.length;
    const soleSeverity = (sev: Severity): boolean =>
      selectedSeverities.length === 1 && selectedSeverities[0] === sev;
    const pressed =
      pressedCard === 'needsreview'
        ? needsReviewOnly && allSeverities
          ? 'needsreview'
          : null
        : pressedCard !== null && !needsReviewOnly && soleSeverity(pressedCard)
          ? pressedCard
          : null;
    // Which card reads as the current filter. Needs review is the filter
    // whenever the list is narrowed to it — by the card OR by the chip, which
    // is how the tab opens — and All changes only when nothing narrows it.
    // Dimming still follows a PRESSED card only, so opening the tab dims
    // nothing.
    const showing =
      pressed ?? (needsReviewOnly ? (allSeverities ? 'needsreview' : null) : allSeverities ? 'total' : null);
    const card = (key: 'needsreview' | 'medium' | 'high') => ({
      active: showing === key,
      inactive: pressed !== null && pressed !== key,
    });
    const press = (key: 'needsreview' | 'medium' | 'high', apply: () => void) => (): void => {
      if (pressed === key) {
        // Pressing the pressed card again lets go of it, as in Detections.
        setPressedCard(null);
        if (key !== 'needsreview') setSelectedSeverities(SEVERITY_OPTIONS);
        return;
      }
      setSelectedSeverities(SEVERITY_OPTIONS);
      setNeedsReviewOnly(false);
      apply();
      setPressedCard(key);
    };
    return [
      {
        // key 'total': the same card as TOTAL in the sibling tabs, style included.
        key: 'total',
        label: 'All changes',
        count: page.total,
        active: showing === 'total',
        inactive: pressed !== null,
        onSelect: (): void => {
          setPressedCard(null);
          setSelectedSeverities(SEVERITY_OPTIONS);
          setNeedsReviewOnly(false);
        },
        tooltip: includeHistorical
          ? 'Every change, flagged or not, previous format included'
          : 'Every change, flagged or not, previous format aside',
      },
      {
        // The question the tab exists to answer. Prominent but NOT coloured:
        // a severity tint here would claim a risk level the set does not have —
        // half of what lands in it carries no finding at all.
        key: 'needsreview',
        label: 'Needs review',
        count: page.needsReviewCount,
        ...card('needsreview'),
        onSelect: press('needsreview', () => setNeedsReviewOnly(true)),
        tooltip: 'Unreviewed changes a rule or the review heuristic flagged',
      },
      ...(['medium', 'high'] as const).map((sev) => ({
        key: sev,
        label: sev[0]!.toUpperCase() + sev.slice(1),
        count: page.severityCounts[sev],
        ...card(sev),
        onSelect: press(sev, () => setSelectedSeverities([sev])),
        tooltip: `Changes whose highest finding is ${sev}`,
      })),
    ];
  }, [
    page.total,
    page.severityCounts,
    page.needsReviewCount,
    selectedSeverities,
    needsReviewOnly,
    includeHistorical,
    pressedCard,
  ]);

  const statusIsDefault =
    statusFilter.length === STATUS_DEFAULT.length && STATUS_DEFAULT.every((o) => statusFilter.includes(o));
  const hasActiveFilters =
    needsReviewOnly ||
    !statusIsDefault ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    sectionFilter !== null ||
    mcpFilter !== null ||
    searchInput !== '' ||
    timeRange !== 'all';

  function handleClearFilters(): void {
    setNeedsReviewOnly(false);
    setPressedCard(null);
    setSelectedSeverities(SEVERITY_OPTIONS);
    setStatusFilter(STATUS_DEFAULT);
    setSectionFilter(null);
    setMcpFilter(null);
    view.resetShared();
  }

  // Checking "Previous format" also lifts Needs review only: those changes
  // carry no review state, so under that chip checking it would show nothing.
  function handleStatusChange(next: readonly StatusOption[]): void {
    if (next.includes('previous') && !statusFilter.includes('previous')) {
      setNeedsReviewOnly(false);
      setPressedCard(null);
    }
    setStatusFilter(next);
  }
  // Nothing current at all, and the only changes recorded are in the previous
  // format: say where they are rather than "no changes".
  const onlyHistorical = page.total === 0 && page.historicalCount > 0 && !includeHistorical;

  // A new panel starts without the previous one's notice.
  useEffect(() => {
    setReviewError(null);
  }, [selectedRow?.event_id]);

  // The write reads the whole trail before appending (seconds on a large
  // install), so the click cannot wait for it. The row, the panel and the
  // cards move at once; the button is disabled until the write settles; the
  // re-read that follows replaces the in-memory status with the trail's. A
  // failed write puts everything back and says so in the panel.
  const handleReview = useCallback(
    (row: ConnectorChangeView) => {
      if (reviewPending !== null) return;
      const from = row.review_status;
      const to = from === 'reviewed' ? 'unreviewed' : 'reviewed';
      const write = window.xcg.setReviewStatus?.(row.event_id, to);
      if (write === undefined) return;
      const setPanel = (status: typeof to): void =>
        setSelectedRow((prev) => (prev?.event_id === row.event_id ? { ...prev, review_status: status } : prev));
      setReviewError(null);
      setReviewPending(row.event_id);
      page.patchReviewStatus(row.event_id, to);
      setPanel(to);
      void write
        .then(() => {
          page.refresh();
        })
        .catch(() => {
          page.patchReviewStatus(row.event_id, from);
          setPanel(from);
          setReviewError("Couldn't save the review status. Try again.");
        })
        .finally(() => {
          setReviewPending(null);
        });
    },
    [page, reviewPending],
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
            options={STATUS_OPTIONS}
            selected={statusFilter}
            onChange={handleStatusChange}
            isOpen={openDropdown === 'status'}
            onToggle={() => setOpenDropdown((prev) => (prev === 'status' ? null : 'status'))}
            dropdownRef={dropdownRef('status')}
            formatOption={(o) => STATUS_LABELS[o]}
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
          {page.loading ? (
            'Loading changes…'
          ) : onlyHistorical ? (
            'No new changes. Older changes in the previous format are available in the Status filter.'
          ) : needsReviewOnly
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
        reviewPending={selectedRow !== null && reviewPending === selectedRow.event_id}
        reviewError={reviewError}
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
