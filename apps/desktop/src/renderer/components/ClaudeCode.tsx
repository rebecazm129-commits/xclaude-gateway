import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import type {
  Category,
  DetectionFilter,
  DetectionRowSlim,
  Severity,
} from '../../shared/types.js';

import { CATEGORY_OPTIONS, SEVERITY_OPTIONS } from './Detections.js';
import { ClaudeCodeRow } from './ClaudeCodeRow.js';
import { DetailDrawer } from './DetailDrawer.js';
import { FilterDropdown } from './FilterDropdown.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';

import styles from './ClaudeCode.module.css';

// Claude Code view (F2.4). Commit 3: real Args column (argsSummary derived
// server-side), filter chips (Flagged only · Severity · Tool · Session ·
// Project), the clickable "N flagged" counter, and session separators in the
// list. The error dot is OUT of F2.4 (conscious cut): nothing on the slim row
// marks failure today — failures live on mcp.response lines, which never
// enter the reader's event set, so it needs its own piece if it comes back.

const ROW_HEIGHT = 40;
// Chrome above/around the list: titlebar (42, mirrors --kraft-titlebar-height
// in index.css) + header (84) + tabs (40) + filter bar (56, .filters) +
// column header (~33). No footer in this view (unlike Detections).
const CHROME_HEIGHT = 255;
// Rows from the end at which we prefetch the next page (same threshold as
// Detections' infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

// Flagged = everything the detectors actually flagged: every category except
// the baseline tool_call_allowed. Server-side (categories axis), so counts
// never lie.
export const FLAGGED_CATEGORIES: readonly Category[] = CATEGORY_OPTIONS.filter(
  (c) => c !== 'tool_call_allowed',
);

// List items: real rows interleaved with synthetic session-separator items.
// Same FixedSizeList, uniform ROW_HEIGHT — a separator is just another 40px
// item, which keeps the virtualization untouched (no VariableSizeList).
export type CcListItem =
  | { kind: 'row'; row: DetectionRowSlim }
  | { kind: 'separator'; ccSession: string; label: string };

function timeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// buildListItems — pure (exported for tests): inserts a separator before the
// first row of each ccSession block (rows arrive ts desc; a block =
// consecutive rows sharing ccSession). Rows without ccSession (historical /
// pre-F2.4) never get separators. Label: short session · project (or mcp) ·
// time span of the block — computed over the LOADED rows, so the span is per
// visible block, not per whole on-disk session.
export function buildListItems(rows: readonly DetectionRowSlim[]): CcListItem[] {
  const items: CcListItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const cc = row.ccSession;
    if (cc !== undefined && (i === 0 || rows[i - 1]!.ccSession !== cc)) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1]!.ccSession === cc) j++;
      const newest = row.ts; // ts desc → first of the block is the newest
      const oldest = rows[j]!.ts;
      const label = `${cc.slice(0, 8)} · ${row.project ?? row.mcp} · ${timeOnly(oldest)}–${timeOnly(newest)}`;
      items.push({ kind: 'separator', ccSession: cc, label });
    }
    items.push({ kind: 'row', row });
  }
  return items;
}

// Single-select semantics on top of the (multi-select) FilterDropdown, same
// gesture Detections already uses for "click the only selected severity →
// back to all": null filter renders as all-checked; checking an option
// narrows to it; re-checking the active one clears back to null.
function pickSingle(
  current: string | null,
  options: readonly string[],
  next: readonly string[],
  set: (v: string | null) => void,
): void {
  const prev = current === null ? options : [current];
  const prevSet = new Set(prev);
  const toggled = options.find((o) => prevSet.has(o) !== next.includes(o));
  if (toggled === undefined) return;
  set(current === toggled ? null : toggled);
}

export function ClaudeCode(): JSX.Element {
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [toolFilter, setToolFilter] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<
    'severity' | 'tool' | 'session' | 'project' | null
  >(null);
  const [listHeight, setListHeight] = useState(
    window.innerHeight - CHROME_HEIGHT,
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Source is FIXED: this view IS the claude-code slice — no Source chip.
  // tool/ccSession ride the server-side filters from commit 1; project is
  // client-side over the loaded page (no server field for it — own piece if
  // dogfood asks). Default on open: everything visible.
  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: null,
      timeRange: selectedTimeRange,
      categories: flaggedOnly ? [...FLAGGED_CATEGORIES] : [...CATEGORY_OPTIONS],
      severities: [...selectedSeverities],
      sources: ['claude-code'],
      tool: toolFilter,
      ccSession: sessionFilter,
    }),
    [selectedTimeRange, flaggedOnly, selectedSeverities, toolFilter, sessionFilter],
  );

  const page = useDetectionPage(filter);
  const { rows } = page;

  // Second, flagged-pinned page subscription for the "N flagged" counter.
  // Verified NOT derivable from the main response: severityCounts and
  // categoryFilteredTotal aggregate the ACTIVE filter's category set by
  // severity, with no per-category breakdown — with the toggle off, the
  // baseline tool_call_allowed is mixed into both numbers and cannot be
  // subtracted (and "baseline ≡ low" is false: pii_* flag at low too). The
  // probe measures the flagged slice under the SAME other axes, independent
  // of the toggle, so the counter never changes meaning when it flips. It
  // rides the same 2s poll; the store coalesces the underlying refresh, so
  // the extra cost is one paginate pass, not a disk read.
  const flaggedProbeFilter: DetectionFilter = useMemo(
    () => ({
      mcp: null,
      timeRange: selectedTimeRange,
      categories: [...FLAGGED_CATEGORIES],
      severities: [...selectedSeverities],
      sources: ['claude-code'],
      tool: toolFilter,
      ccSession: sessionFilter,
    }),
    [selectedTimeRange, selectedSeverities, toolFilter, sessionFilter],
  );
  const flaggedProbe = useDetectionPage(flaggedProbeFilter);

  // Chip options: distinct values over the loaded rows (page-local; an active
  // filter keeps its own value present so it can be toggled back off).
  const toolOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.toolName !== undefined) s.add(r.toolName);
    if (toolFilter !== null) s.add(toolFilter);
    return [...s].sort();
  }, [rows, toolFilter]);
  const sessionOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.ccSession !== undefined) s.add(r.ccSession);
    if (sessionFilter !== null) s.add(sessionFilter);
    return [...s].sort();
  }, [rows, sessionFilter]);
  const projectOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.project !== undefined) s.add(r.project);
    if (projectFilter !== null) s.add(projectFilter);
    return [...s].sort();
  }, [rows, projectFilter]);

  // Client-side project filter (see note above) → then session separators.
  const displayRows = useMemo(
    () =>
      projectFilter === null
        ? rows
        : rows.filter((r) => r.project === projectFilter),
    [rows, projectFilter],
  );
  const items = useMemo(() => buildListItems(displayRows), [displayRows]);

  useEffect(() => {
    function onResize(): void {
      setListHeight(window.innerHeight - CHROME_HEIGHT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Outside-click closes the open dropdown (Detections' pattern, single bar ref).
  useEffect(() => {
    if (openDropdown === null) return;
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      if (!(barRef.current?.contains(e.target as Node) ?? false)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [openDropdown]);

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

  const flaggedChipClass = flaggedOnly
    ? `${styles['flaggedChip']} ${styles['flaggedChipActive']}`
    : styles['flaggedChip'];

  return (
    <>
      <div className={styles['filters']} ref={barRef}>
        <button
          type="button"
          className={flaggedChipClass}
          aria-pressed={flaggedOnly}
          onClick={() => setFlaggedOnly((v) => !v)}
        >
          Flagged only
        </button>
        <FilterDropdown
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={selectedSeverities}
          onChange={setSelectedSeverities}
          isOpen={openDropdown === 'severity'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'severity' ? null : 'severity'))
          }
        />
        <FilterDropdown
          label="Tool"
          options={toolOptions}
          selected={toolFilter === null ? toolOptions : [toolFilter]}
          onChange={(next) => pickSingle(toolFilter, toolOptions, next, setToolFilter)}
          isOpen={openDropdown === 'tool'}
          onToggle={() => setOpenDropdown((v) => (v === 'tool' ? null : 'tool'))}
        />
        <FilterDropdown
          label="Session"
          options={sessionOptions}
          selected={sessionFilter === null ? sessionOptions : [sessionFilter]}
          onChange={(next) =>
            pickSingle(sessionFilter, sessionOptions, next, setSessionFilter)
          }
          isOpen={openDropdown === 'session'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'session' ? null : 'session'))
          }
          formatOption={(o) => o.slice(0, 8)}
        />
        <FilterDropdown
          label="Project"
          options={projectOptions}
          selected={projectFilter === null ? projectOptions : [projectFilter]}
          onChange={(next) =>
            pickSingle(projectFilter, projectOptions, next, setProjectFilter)
          }
          isOpen={openDropdown === 'project'}
          onToggle={() =>
            setOpenDropdown((v) => (v === 'project' ? null : 'project'))
          }
        />
        <div className={styles['timeFilterSpacer']}>
          <button
            type="button"
            className={flaggedOnly ? `${styles['flaggedCounter']} ${styles['flaggedCounterActive']}` : styles['flaggedCounter']}
            onClick={() => setFlaggedOnly((v) => !v)}
            title="Show only flagged events"
          >
            {flaggedProbe.totalMatching} flagged
          </button>
          <TimeFilter value={selectedTimeRange} onChange={setSelectedTimeRange} />
        </div>
      </div>
      {items.length === 0 ? (
        <div className={styles['empty']}>
          {rows.length === 0
            ? 'No Claude Code activity yet. Install the Claude Code hook in Sources to start auditing.'
            : 'No matches with current filters.'}
        </div>
      ) : (
        <div className={styles['listContainer']}>
          <div className={styles['columnHeader']}>
            <span className={styles['columnHeaderCell']}>Severity</span>
            <span className={styles['columnHeaderCell']}>Tool</span>
            <span className={styles['columnHeaderCell']}>Args</span>
            <span className={styles['columnHeaderCell']}>When</span>
          </div>
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
      )}
      {selectedRow !== null && (
        <DetailDrawer row={selectedRow} onClose={handleDrawerClose} />
      )}
    </>
  );
}
