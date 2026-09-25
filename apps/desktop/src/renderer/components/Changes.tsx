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
// default, behind a quiet note that shows them. They are NOT marked reviewed
// to get them out of the way: nobody reviewed them.

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
import { Tooltip } from './Tooltip.js';
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
import rowStyles from './ChangeRow.module.css';

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
  const [includeHistorical, setIncludeHistorical] = useState(false);
  const [selectedSeverities, setSelectedSeverities] = useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [reviewFilter, setReviewFilter] = useState<readonly ReviewState[]>(REVIEW_OPTIONS);
  const [sectionFilter, setSectionFilter] = useState<readonly ConnectorChangeView['section'][] | null>(null);
  const [mcpFilter, setMcpFilter] = useState<readonly string[] | null>(null);
  const [selectedRow, setSelectedRow] = useState<ConnectorChangeView | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const filter: ChangeFilter = useMemo(
    () => ({
      needsReviewOnly,
      includeHistorical,
      severities: selectedSeverities,
      review: reviewFilter.length === REVIEW_OPTIONS.length ? [] : reviewFilter,
      sections: sectionFilter ?? [],
      mcps: mcpFilter ?? [],
      text: textFilter,
      timeRange,
      customRange: customRange ?? null,
    }),
    [needsReviewOnly, includeHistorical, selectedSeverities, reviewFilter, sectionFilter, mcpFilter, textFilter, timeRange, customRange],
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
    const card = (key: 'needsreview' | 'medium' | 'high') => ({
      active: pressed === key,
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
        active: pressed === null,
        inactive: pressed !== null,
        onSelect: (): void => {
          setPressedCard(null);
          setSelectedSeverities(SEVERITY_OPTIONS);
          setNeedsReviewOnly(false);
        },
        tooltip: includeHistorical
          ? 'Every change, flagged or not, historical ones included'
          : 'Every change, flagged or not, historical ones aside',
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

  const hasActiveFilters =
    needsReviewOnly ||
    includeHistorical ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    reviewFilter.length !== REVIEW_OPTIONS.length ||
    sectionFilter !== null ||
    mcpFilter !== null ||
    searchInput !== '' ||
    timeRange !== 'all';

  function handleClearFilters(): void {
    setNeedsReviewOnly(false);
    setIncludeHistorical(false);
    setPressedCard(null);
    setSelectedSeverities(SEVERITY_OPTIONS);
    setReviewFilter(REVIEW_OPTIONS);
    setSectionFilter(null);
    setMcpFilter(null);
    view.resetShared();
  }

  // Showing historical changes also lifts Needs review only: none of them can
  // need review, so under that chip "show them" would show nothing.
  function showHistorical(): void {
    setIncludeHistorical(true);
    setNeedsReviewOnly(false);
    setPressedCard(null);
  }
  const plural = (n: number): string => `${n} historical change${n === 1 ? '' : 's'}`;
  // Nothing in scope at all, and the only changes recorded are the hidden
  // historical ones: say so, and offer the way in, rather than "no changes".
  const onlyHistorical = page.total === 0 && page.historicalCount > 0 && !includeHistorical;

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
          {page.historicalCount > 0 && (
            // A note, not a chip: a fact about the trail that doubles as the
            // way in. Styled as the "Clear filters" link, so it reads as
            // something you can press.
            <span className={rowStyles['historicalNote']}>
              <Tooltip text="Recorded by the previous format, before rules and review existed">
                <button
                  type="button"
                  className={bar['clearInline']}
                  aria-pressed={includeHistorical}
                  onClick={() => (includeHistorical ? setIncludeHistorical(false) : showHistorical())}
                >
                  {includeHistorical ? `Hide ${plural(page.historicalCount)}` : plural(page.historicalCount)}
                </button>
              </Tooltip>
            </span>
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
            <span className={rowStyles['emptyHistorical']}>
              No new changes. {plural(page.historicalCount)}{' '}
              {page.historicalCount === 1 ? 'is' : 'are'} hidden.
              <button type="button" className={bar['clearInline']} onClick={showHistorical}>
                Show them
              </button>
            </span>
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
