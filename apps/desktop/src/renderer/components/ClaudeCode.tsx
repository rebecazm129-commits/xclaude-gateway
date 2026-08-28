import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import type {
  Category,
  DetectionFilter,
  DetectionRowSlim,
  Severity,
} from '../../shared/types.js';

import { AuditFooter } from './AuditFooter.js';
import { CATEGORY_OPTIONS, SEVERITY_OPTIONS, INITIAL_LIST_HEIGHT, SEARCH_DEBOUNCE_MS } from './Detections.js';
import { ClaudeCodeRow } from './ClaudeCodeRow.js';
import { DateRangePicker } from './DateRangePicker.js';
import { DetailDrawer } from './DetailDrawer.js';
import { formatTimestamp } from './detections-format.js';
import { FilterDropdown } from './FilterDropdown.js';
import { SeverityBreakdown } from './SeverityBreakdown.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';
import { Tooltip } from './Tooltip.js';

import styles from './ClaudeCode.module.css';
// The right-aligned time group still shares Detections' .timeFilterSpacer,
// and the filtered-empty state (emptyFiltered/clearFiltersButton, dogfood
// 22/07) shares its whole style family too (commit 5f anti-drift). The
// multi-row .toolbar band lives HERE and is shared back: Detections
// renders it too since the toolbar parity (22/07).
import toolbarStyles from './Detections.module.css';

// Claude Code view (F2.4): the claude-code slice of the audit trail as its
// own tab. Server-filtered list (severity/category/tool/session/project/
// status/text/time incl. custom range), stable facet inventories, session
// separators, severity cards, shared footer. The error dot rides the real
// request↔response outcome correlation (delta final — the earlier cut came
// back once the data existed).

const ROW_HEIGHT = 40;
// Rows from the end at which we prefetch the next page (same threshold as
// Detections' infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

// Flagged = everything the detectors actually flagged: every category except
// the baseline tool_call_allowed. Server-side (categories axis), so counts
// never lie.
export const FLAGGED_CATEGORIES: readonly Category[] = CATEGORY_OPTIONS.filter(
  (c) => c !== 'tool_call_allowed',
);

// Status facet (delta final): fixed axis — ok/error. Requests without a
// matched response (outcome undefined) are neither: an active Status filter
// excludes them, and the chip's (n/2) counts statuses, not rows.
const STATUS_OPTIONS: readonly string[] = ['ok', 'error'];
const STATUS_LABELS: Record<string, string> = { ok: 'OK', error: 'Error' };

// (SEARCH_DEBOUNCE_MS moved to Detections.js with the filter parity, 22/07 —
// same import direction as the option inventories above.)

// List items: real rows interleaved with synthetic session-separator items.
// Same FixedSizeList, uniform ROW_HEIGHT — a separator is just another 40px
// item, which keeps the virtualization untouched (no VariableSizeList).
export type CcListItem =
  | { kind: 'row'; row: DetectionRowSlim }
  | { kind: 'separator'; ccSession: string; label: string };

// "17 Jul, 19:13" — formatTimestamp's grammar minus the seconds.
function startedStamp(iso: string): string {
  return formatTimestamp(iso).replace(/:\d{2}$/, '');
}

// buildListItems — pure (exported for tests): inserts a separator before the
// first row of each ccSession block (rows arrive ts desc; a block =
// consecutive rows sharing ccSession). Rows without ccSession (historical /
// pre-F2.4) never get separators. Label (commit-4 redesign, hash dropped):
// project (or mcp) + "started <short date> <HH:MM>" of the session's first
// event — the oldest row of the block within the LOADED page.
export function buildListItems(rows: readonly DetectionRowSlim[]): CcListItem[] {
  const items: CcListItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const cc = row.ccSession;
    if (cc !== undefined && (i === 0 || rows[i - 1]!.ccSession !== cc)) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1]!.ccSession === cc) j++;
      const oldest = rows[j]!.ts; // ts desc → last of the block is the oldest
      const label = `${row.project ?? row.mcp} · started ${startedStamp(oldest)}`;
      items.push({ kind: 'separator', ccSession: cc, label });
    }
    items.push({ kind: 'row', row });
  }
  return items;
}

// Multi-select facet gesture (commit 6, Detections' Severity/Category
// semantics): null = no filter, rendered as all-checked; toggling narrows to
// the checked subset; all checked OR none checked collapses back to null.
function facetChange(
  next: readonly string[],
  all: readonly string[],
  set: (v: readonly string[] | null) => void,
): void {
  set(next.length === 0 || next.length === all.length ? null : [...next]);
}

// Facet options = the server's stable inventory (computed on the base
// filter, so picking Bash never removes the other tools from the menu),
// unioned with any active selection whose value slid out of the current
// time window — it must stay visible to be un-checkable.
function facetOptions(
  inventory: readonly string[],
  active: readonly string[] | null,
): string[] {
  if (active === null) return [...inventory];
  const s = new Set([...inventory, ...active]);
  return [...s].sort();
}

export function ClaudeCode(): JSX.Element {
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  // Facet selections (commit 6): null = no filter; otherwise the checked
  // subset (multi-select, membership shipped to the server).
  const [toolFilter, setToolFilter] = useState<readonly string[] | null>(null);
  const [sessionFilter, setSessionFilter] = useState<readonly string[] | null>(null);
  const [projectFilter, setProjectFilter] = useState<readonly string[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<readonly string[] | null>(null);
  // Free-text search: raw input debounced into the shipped filter value.
  const [searchInput, setSearchInput] = useState('');
  const [textFilter, setTextFilter] = useState<string | null>(null);
  // Custom date range (active when the time segment is 'custom').
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [openDropdown, setOpenDropdown] = useState<
    'severity' | 'tool' | 'session' | 'project' | 'status' | null
  >(null);
  // Measured list height (Detections' exact pattern — fallback replaced by
  // the measuring layout effect before the first paint).
  const [listHeight, setListHeight] = useState(INITIAL_LIST_HEIGHT);
  const listViewportRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // One container ref PER chip (Detections' shape): the close criterion is
  // "outside the OPEN dropdown" (its chip + its menu), so the handler needs
  // exactly that chip's node — never the whole toolbar.
  const dropdownRefs = useRef<Record<
    'severity' | 'tool' | 'session' | 'project' | 'status',
    HTMLDivElement | null
  >>({ severity: null, tool: null, session: null, project: null, status: null });

  // Source is FIXED: this view IS the claude-code slice — no Source chip.
  // tool/ccSession/project are all server-side since commit 6 (project moved
  // from client-side: with facets and multi-select on the server, it is the
  // same pattern — and the counts stop lying under a project filter).
  // Default on open: everything visible.
  // Debounce the search box into the shipped text filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      setTextFilter(trimmed === '' ? null : trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: null,
      timeRange: selectedTimeRange,
      categories: flaggedOnly ? [...FLAGGED_CATEGORIES] : [...CATEGORY_OPTIONS],
      severities: [...selectedSeverities],
      sources: ['claude-code'],
      tool: toolFilter === null ? null : [...toolFilter],
      ccSession: sessionFilter === null ? null : [...sessionFilter],
      project: projectFilter === null ? null : [...projectFilter],
      status: statusFilter === null ? null : [...statusFilter],
      text: textFilter,
      customRange:
        selectedTimeRange === 'custom' && customFrom !== '' && customTo !== ''
          ? { from: customFrom, to: customTo }
          : null,
    }),
    [
      selectedTimeRange, flaggedOnly, selectedSeverities, toolFilter,
      sessionFilter, projectFilter, statusFilter, textFilter, customFrom, customTo,
    ],
  );

  const page = useDetectionPage(filter);
  const { rows } = page;

  // Chip options: the server's STABLE facet inventories (commit 6) — computed
  // over the base filter, so an active tool/session/project selection never
  // removes the other values from its own menu.
  const toolOptions = useMemo(
    () => facetOptions(page.facets.tools, toolFilter),
    [page.facets.tools, toolFilter],
  );
  // Session options: the facet's OWN order (recent-first, server-sorted) —
  // no alphabetical re-sort; stray active selections append at the end.
  const sessionOptions = useMemo(() => {
    const ids = page.facets.ccSessions.map((s) => s.id);
    if (sessionFilter !== null) {
      for (const id of sessionFilter) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }, [page.facets.ccSessions, sessionFilter]);
  const projectOptions = useMemo(
    () => facetOptions(page.facets.projects, projectFilter),
    [page.facets.projects, projectFilter],
  );

  // Human labels for the Session menu — SERVER data since the final delta
  // (facets.ccSessions carries started/where for EVERY session in the
  // window, loaded page or not). The page-derived labelling died with it.
  const sessionMeta = useMemo(
    () => new Map(page.facets.ccSessions.map((s) => [s.id, s])),
    [page.facets.ccSessions],
  );

  // Rows arrive fully server-filtered (project included, commit 6) → session
  // separators directly over them.
  const items = useMemo(() => buildListItems(rows), [rows]);

  // Measured, not computed (Detections' exact pattern — see the comment on
  // its measuring effect): .listViewport is flex:1/min-height:0, the layout
  // effect reads it before paint, the ResizeObserver tracks window resizes
  // and banners appearing/disappearing above. Re-runs on hasItems: the
  // viewport only exists while the list renders.
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const el = listViewportRef.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const h = el.clientHeight;
      // Layout-less environments (jsdom) report 0 — keep the fallback.
      if (h > 0) setListHeight(h);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasItems]);

  // Escape and outside-click close the open dropdown. "Outside" means outside
  // the OPEN chip's own container (chip + menu): clicking the search box, the
  // time segment or ANOTHER chip now closes it — and on another chip the same
  // click's onToggle then sees v === null and opens that one (close-then-open,
  // no fighting states). The old criterion compared against the whole toolbar,
  // which left a long scrolling menu (Session: 25) undismissable from inside
  // the bar. The setTimeout(0) "active" guard is gone: this effect registers
  // its listener post-commit, after the click that opened the menu has fully
  // finished — and a mousedown on the open chip itself lands inside its
  // container anyway. StrictMode's dev double-invoke is safe: the cleanup
  // removes both listeners before the re-registration, never two copies.
  useEffect(() => {
    if (openDropdown === null) return;
    const openKey = openDropdown; // narrowed: the closure below indexes with a non-null key
    function onMouseDown(e: MouseEvent): void {
      const open = dropdownRefs.current[openKey];
      if (!(open?.contains(e.target as Node) ?? false)) {
        setOpenDropdown(null);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenDropdown(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openDropdown]);

  // Severity-card gestures — Detections' exact narrowing behavior.
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

  // Detections' exact pattern (dogfood 22/07): the empty-state fork needs
  // RENDERER state — rows arrive server-filtered, so an empty page cannot
  // distinguish "no CC activity" from "no matches" (and page.total is the
  // whole store, both sources, so it is no signal either).
  const hasActiveFilters =
    flaggedOnly ||
    selectedSeverities.length !== SEVERITY_OPTIONS.length ||
    toolFilter !== null ||
    sessionFilter !== null ||
    projectFilter !== null ||
    statusFilter !== null ||
    textFilter !== null ||
    // 'custom' is covered here too — any non-default time segment is active.
    selectedTimeRange !== 'all';

  function handleClearFilters(): void {
    setFlaggedOnly(false);
    setSelectedSeverities(SEVERITY_OPTIONS);
    setToolFilter(null);
    setSessionFilter(null);
    setProjectFilter(null);
    setStatusFilter(null);
    setSearchInput('');
    setTextFilter(null); // immediate — don't wait out the debounce
    setSelectedTimeRange('all');
    setCustomFrom('');
    setCustomTo('');
  }

  const flaggedChipClass = flaggedOnly
    ? `${styles['flaggedChip']} ${styles['flaggedChipActive']}`
    : styles['flaggedChip'];

  return (
    <>
      <SeverityBreakdown
        counts={page.severityCounts}
        total={page.categoryFilteredTotal}
        selectedSeverities={selectedSeverities}
        totalSeverityOptionsCount={SEVERITY_OPTIONS.length}
        onSelectTotal={handleSelectTotal}
        onSelectSeverity={handleSelectSeverity}
      />
      <div className={styles['toolbar']}>
        <div className={styles['toolbarRow']}>
          <input
            type="search"
            className={styles['searchBox']}
            placeholder="Search tool or details…"
            aria-label="Search tool or details"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <div className={toolbarStyles['timeFilterSpacer']}>
            <TimeFilter
              value={selectedTimeRange}
              onChange={setSelectedTimeRange}
              allowCustom
            />
          </div>
        </div>
        <div className={`${styles['toolbarRow']} ${styles['chipsRow']}`}>
        <Tooltip text="Show only calls that triggered a detection">
          <button
            type="button"
            className={flaggedChipClass}
            aria-pressed={flaggedOnly}
            onClick={() => setFlaggedOnly((v) => !v)}
          >
            Flagged only
          </button>
        </Tooltip>
        <FilterDropdown
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={selectedSeverities}
          onChange={setSelectedSeverities}
          dropdownRef={(el) => { dropdownRefs.current.severity = el; }}
          isOpen={openDropdown === 'severity'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'severity' ? null : 'severity'))
          }
        />
        <FilterDropdown
          label="Tool"
          options={toolOptions}
          selected={toolFilter ?? toolOptions}
          onChange={(next) => facetChange(next, toolOptions, setToolFilter)}
          dropdownRef={(el) => { dropdownRefs.current.tool = el; }}
          isOpen={openDropdown === 'tool'}
          onToggle={() => setOpenDropdown((v) => (v === 'tool' ? null : 'tool'))}
        />
        <FilterDropdown
          label="Session"
          options={sessionOptions}
          selected={sessionFilter ?? sessionOptions}
          onChange={(next) => facetChange(next, sessionOptions, setSessionFilter)}
          dropdownRef={(el) => { dropdownRefs.current.session = el; }}
          isOpen={openDropdown === 'session'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'session' ? null : 'session'))
          }
          tooltip="Filter by Claude Code session"
          formatOption={(o) => {
            const m = sessionMeta.get(o);
            if (m === undefined) return o.slice(0, 8);
            // One line: human label ellipsizes, the dimmed hash keeps its
            // slot on the right (commit 6 layout).
            return (
              <span className={styles['sessionOption']}>
                <span className={styles['sessionOptionLabel']}>
                  {`started ${startedStamp(m.started)} · ${m.where}`}
                </span>
                <span className={styles['sessionHash']}>{o.slice(0, 8)}</span>
              </span>
            );
          }}
        />
        <FilterDropdown
          label="Status"
          options={STATUS_OPTIONS}
          selected={statusFilter ?? STATUS_OPTIONS}
          onChange={(next) => facetChange(next, STATUS_OPTIONS, setStatusFilter)}
          dropdownRef={(el) => { dropdownRefs.current.status = el; }}
          isOpen={openDropdown === 'status'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'status' ? null : 'status'))
          }
          formatOption={(o) => STATUS_LABELS[o] ?? o}
        />
        {projectOptions.length > 0 && (
          // Hidden until the facet inventory carries at least one project —
          // today every historical envelope lacks cwd, so the chip would
          // offer an empty menu (commit-4 dogfood note).
          <FilterDropdown
            label="Project"
            options={projectOptions}
            selected={projectFilter ?? projectOptions}
            onChange={(next) => facetChange(next, projectOptions, setProjectFilter)}
            dropdownRef={(el) => { dropdownRefs.current.project = el; }}
            isOpen={openDropdown === 'project'}
            onToggle={() =>
              setOpenDropdown((v) => (v === 'project' ? null : 'project'))
            }
            tooltip="Filter by the folder where Claude Code was running"
          />
        )}
        {hasActiveFilters && (
          // Always-reachable reset (producto 22/07): same handler as the
          // filtered-empty state's button, which stays — this one is the
          // discovery-level affordance while results are still visible.
          <button
            type="button"
            className={styles['clearInline']}
            onClick={handleClearFilters}
          >
            Clear filters
          </button>
        )}
        {selectedTimeRange === 'custom' && (
          // DateRangePicker (replaces the native date inputs — the house
          // datepicker exists now): IN the chips row since dogfood 3ª ronda,
          // keeping the old .customRange spot (right-aligned at the end,
          // whole-unit wrap on narrow windows). The view stays the owner of
          // customFrom/customTo — same wire contract.
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
      {items.length === 0 ? (
        hasActiveFilters ? (
          <div className={toolbarStyles['emptyFiltered']}>
            <h2 className={toolbarStyles['emptyFilteredHeading']}>No matches with current filters</h2>
            <p className={toolbarStyles['emptyFilteredSubhead']}>
              Try widening the time range or turning off Flagged only.
            </p>
            <button
              type="button"
              className={toolbarStyles['clearFiltersButton']}
              onClick={handleClearFilters}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className={styles['empty']}>
            No Claude Code activity yet. Install the Claude Code hook in Sources to start auditing.
          </div>
        )
      ) : (
        <div className={styles['listContainer']}>
          <div className={styles['columnHeader']}>
            <span className={styles['columnHeaderCell']}>Time</span>
            <span className={styles['columnHeaderCell']}>Severity</span>
            <span className={styles['columnHeaderCell']}>Tool</span>
            <span className={styles['columnHeaderCell']}>Details</span>
          </div>
          <div className={styles['listViewport']} ref={listViewportRef}>
            <FixedSizeList
              height={listHeight}
              width="100%"
              itemSize={ROW_HEIGHT}
              itemCount={items.length}
              itemKey={(index) => {
                const it = items[index];
                if (it === undefined) return index;
                return it.kind === 'row' ? it.row.id : `sep-${it.ccSession}-${index}`;
              }}
              onItemsRendered={({ visibleStopIndex }) => {
                if (page.hasMore && visibleStopIndex >= items.length - LOAD_MORE_THRESHOLD) {
                  page.loadMore();
                }
              }}
            >
              {({ index, style }) => {
                const item = items[index];
                if (item === undefined) return null;
                if (item.kind === 'separator') {
                  return (
                    <div style={style}>
                      <div className={styles['sessionSeparator']}>{item.label}</div>
                    </div>
                  );
                }
                return (
                  <div style={style}>
                    <ClaudeCodeRow
                      row={item.row}
                      selected={selectedRow?.id === item.row.id}
                      onClick={() => handleRowClick(item.row)}
                    />
                  </div>
                );
              }}
            </FixedSizeList>
          </div>
        </div>
      )}
      {selectedRow !== null && (
        <DetailDrawer row={selectedRow} onClose={handleDrawerClose} />
      )}
      <AuditFooter filter={filter} total={page.total} totalMatching={page.totalMatching} />
    </>
  );
}
