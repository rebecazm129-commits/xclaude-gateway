// The skeleton every audit list view repeats: a debounced search box, a time
// range with an optional custom window, a measured list height, and one open
// dropdown at a time.
//
// WHY EXTRACT IT. Detections and Claude Code each grew their own copy — 472
// and 555 lines, with the second carrying comments that say so out loud
// ("Detections' exact pattern", "ClaudeCode's exact pattern"). Two copies is a
// smell; a third, for Changes, is a guarantee that they drift. The parts that
// differ between the views — which facets exist, what a row looks like, what
// the filter means — stay in the views, where they belong.
//
// Deliberately NOT included: the DetectionFilter itself. Each view composes a
// different one and shipping a half-built filter from here would make the
// shape harder to read, not easier.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { TimeRange } from '../components/TimeFilter.js';

/** Fallback until the layout effect measures the real viewport. Layout-less
 *  environments (jsdom) never replace it. */
export const INITIAL_LIST_HEIGHT = 400;
export const SEARCH_DEBOUNCE_MS = 250;

export interface ListViewState<DropdownKey extends string> {
  /** Raw input, bound to the search box. */
  searchInput: string;
  setSearchInput: (v: string) => void;
  /** Debounced value, safe to ship in a filter. null when empty. */
  textFilter: string | null;

  timeRange: TimeRange;
  setTimeRange: (r: TimeRange) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
  /** The {from,to} a filter should carry, or undefined when the range is not
   *  a complete custom window. */
  customRange: { from: string; to: string } | undefined;

  /** Which chip has its menu open, if any. */
  openDropdown: DropdownKey | null;
  /** Full setter: the call sites use the updater form to toggle. */
  setOpenDropdown: Dispatch<SetStateAction<DropdownKey | null>>;
  /** A stable container ref per chip, so an outside click knows what "outside"
   *  means. One object per key, created on first ask and kept. */
  dropdownRef: (key: DropdownKey) => RefObject<HTMLDivElement>;

  listHeight: number;
  listViewportRef: React.RefObject<HTMLDivElement>;
  /** Call with the current row count: the viewport only exists while there
   *  are rows, so the measurement has to re-run when that flips. */
  setHasRows: (v: boolean) => void;

  /** Clears search, range and the open menu. Facet state stays with the view. */
  resetShared: () => void;
}

export function useListView<DropdownKey extends string>(): ListViewState<DropdownKey> {
  const [searchInput, setSearchInput] = useState('');
  const [textFilter, setTextFilter] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [openDropdown, setOpenDropdown] = useState<DropdownKey | null>(null);
  const [listHeight, setListHeight] = useState(INITIAL_LIST_HEIGHT);
  const [hasRows, setHasRows] = useState(false);

  const listViewportRef = useRef<HTMLDivElement>(null);
  const dropdownRefs = useRef(new Map<DropdownKey, RefObject<HTMLDivElement>>());

  const dropdownRef = useCallback((key: DropdownKey): RefObject<HTMLDivElement> => {
    const existing = dropdownRefs.current.get(key);
    if (existing !== undefined) return existing;
    const created: RefObject<HTMLDivElement> = { current: null };
    dropdownRefs.current.set(key, created);
    return created;
  }, []);

  // Debounce the search box into the shipped text filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      setTextFilter(trimmed === '' ? null : trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // The list's height is MEASURED from the viewport (flex:1 / min-height:0),
  // never derived from window.innerHeight minus a chrome constant — a banner
  // appearing above the list would make that arithmetic wrong. useLayoutEffect
  // measures synchronously before the first paint; the ResizeObserver keeps it
  // true afterwards.
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
  }, [hasRows]);

  // Escape and outside-click close the open dropdown. "Outside" means outside
  // the OPEN chip's own container only — clicking another chip closes this one
  // and that click's own toggle opens the other: close-then-open. The listener
  // registers post-commit, after the opening click, so no "active" guard is
  // needed; StrictMode's double-invoke is covered by the cleanup.
  useEffect(() => {
    if (openDropdown === null) return undefined;
    const openKey = openDropdown;
    function onMouseDown(e: MouseEvent): void {
      const open = dropdownRefs.current.get(openKey)?.current;
      if (!(open?.contains(e.target as Node) ?? false)) setOpenDropdown(null);
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

  const customRange =
    timeRange === 'custom' && customFrom !== '' && customTo !== ''
      ? { from: customFrom, to: customTo }
      : undefined;

  const resetShared = useCallback(() => {
    setSearchInput('');
    // Immediate — don't wait out the debounce. Clearing only the input would
    // leave the shipped filter live for another 250ms, so "Clear filters"
    // would visibly not clear.
    setTextFilter(null);
    setTimeRange('all');
    setCustomFrom('');
    setCustomTo('');
    setOpenDropdown(null);
  }, []);

  return {
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
    resetShared,
  };
}
