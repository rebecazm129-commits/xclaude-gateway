import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import {
  addMonths,
  buildMonthGrid,
  dayCellState,
  formatIsoLocal,
  monthLabel,
  parseIsoToLocalDate,
  resolveRangeTap,
} from './date-range-logic.js';
import type { DayCell } from './date-range-logic.js';

import styles from './DateRangePicker.module.css';

// DateRangePicker — replaces the native <input type="date"> pair of the
// Custom time segment. Controlled: the views keep owning customFrom/customTo
// ('' or 'YYYY-MM-DD', the DetectionFilter.customRange wire format,
// local-day semantics since d6926da). ALL calendar math lives in
// date-range-logic.ts — this file is only state, wiring and skin.

interface DateRangePickerProps {
  readonly from: string; // '' or 'YYYY-MM-DD'
  readonly to: string;
  readonly onChange: (from: string, to: string) => void;
}

// Monday-first, matching buildMonthGrid.
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string').join(' ');
}

export function DateRangePicker({ from, to, onChange }: DateRangePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ year: 0, month: 0 });
  // Roving tabindex (WAI-ARIA APG date grid): exactly one cell is tabbable;
  // arrows move it. Always a date inside the visible month's grid.
  const [activeIso, setActiveIso] = useState('');
  // Computed once when the panel opens — not per render.
  const [todayIso, setTodayIso] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  // Set when focus must land on the active grid cell after the next render
  // (keyboard open, arrow/page navigation across month re-renders).
  const pendingGridFocus = useRef(false);

  function handleTriggerClick(e: ReactMouseEvent<HTMLButtonElement>): void {
    if (open) {
      // ONE shared panel: either trigger toggles it closed.
      setOpen(false);
      return;
    }
    const now = new Date();
    setTodayIso(formatIsoLocal(now));
    // Initial month: from's month if set, otherwise the current one.
    const fromDate = from === '' ? null : parseIsoToLocalDate(from);
    const year = fromDate?.getFullYear() ?? now.getFullYear();
    const month = fromDate?.getMonth() ?? now.getMonth();
    setView({ year, month });
    // Active cell on open: the from endpoint (always inside the initial
    // month when set), else day 1 of the visible month.
    setActiveIso(fromDate !== null ? from : formatIsoLocal(new Date(year, month, 1)));
    openerRef.current = e.currentTarget;
    // detail === 0 → keyboard activation: focus enters the grid.
    pendingGridFocus.current = e.detail === 0;
    setOpen(true);
  }

  function closeAndRestoreFocus(): void {
    setOpen(false);
    const opener = openerRef.current;
    if (opener !== null && document.body.contains(opener)) {
      opener.focus();
    }
  }

  // Outside-click closes — the views' dropdown pattern (the timeout+flag
  // skips the mousedown that opened the panel).
  useEffect(() => {
    if (!open) return;
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      if (!(rootRef.current?.contains(e.target as Node) ?? false)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  // Escape closes and hands focus back to the opening trigger. Listener
  // only lives while the panel is open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false);
        const opener = openerRef.current;
        if (opener !== null && document.body.contains(opener)) {
          opener.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Focus follows the active cell across renders when requested (keyboard
  // open / grid navigation, including month changes where the cell node is
  // brand new).
  useEffect(() => {
    if (!open || !pendingGridFocus.current) return;
    pendingGridFocus.current = false;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-iso="${activeIso}"]`)
      ?.focus();
  }, [open, activeIso, view]);

  // Move the active cell to a concrete date; if it leaves the visible
  // month, the calendar navigates with it.
  function moveActive(target: Date): void {
    if (target.getFullYear() !== view.year || target.getMonth() !== view.month) {
      setView({ year: target.getFullYear(), month: target.getMonth() });
    }
    setActiveIso(formatIsoLocal(target));
    pendingGridFocus.current = true;
  }

  // ‹ › and PageUp/PageDown: month step keeping the active day, clamped to
  // the target month's length so the roving cell always stays visible.
  function navMonth(delta: number, followFocus: boolean): void {
    const next = addMonths(view.year, view.month, delta);
    const day = parseIsoToLocalDate(activeIso)?.getDate() ?? 1;
    const daysInNext = new Date(next.year, next.month + 1, 0).getDate();
    setView(next);
    setActiveIso(formatIsoLocal(new Date(next.year, next.month, Math.min(day, daysInNext))));
    pendingGridFocus.current = followFocus;
  }

  function handleTap(iso: string): void {
    setActiveIso(iso);
    const next = resolveRangeTap(
      { from: from === '' ? null : from, to: to === '' ? null : to },
      iso,
    );
    onChange(next.from ?? '', next.to ?? '');
    // Completing the range closes the panel and returns focus to the
    // trigger that opened it.
    if (next.from !== null && next.to !== null) {
      closeAndRestoreFocus();
    }
  }

  function handleGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const d = parseIsoToLocalDate(activeIso);
    if (d === null) return;
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    // Monday-first weekday offset of the active day (Home/End targets).
    const wd = (d.getDay() + 6) % 7;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        moveActive(new Date(y, m, day + 1));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveActive(new Date(y, m, day - 1));
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(new Date(y, m, day + 7));
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(new Date(y, m, day - 7));
        break;
      case 'PageUp':
        e.preventDefault();
        navMonth(-1, true);
        break;
      case 'PageDown':
        e.preventDefault();
        navMonth(1, true);
        break;
      case 'Home':
        e.preventDefault();
        moveActive(new Date(y, m, day - wd));
        break;
      case 'End':
        e.preventDefault();
        moveActive(new Date(y, m, day + (6 - wd)));
        break;
      case 'Enter':
      case ' ':
        // preventDefault also suppresses the button's native click, so the
        // tap runs exactly once.
        e.preventDefault();
        handleTap(activeIso);
        break;
      default:
        break;
    }
  }

  function handleTodayClick(): void {
    // Navigation only — Today never selects the day (dogfood-pending call).
    const t = parseIsoToLocalDate(todayIso);
    if (t === null) return;
    setView({ year: t.getFullYear(), month: t.getMonth() });
    setActiveIso(todayIso);
  }

  const weeks: DayCell[][] = [];
  if (open) {
    const grid = buildMonthGrid(view.year, view.month);
    for (let i = 0; i < grid.length; i += 7) weeks.push(grid.slice(i, i + 7));
  }

  const fromOrNull = from === '' ? null : from;
  const toOrNull = to === '' ? null : to;

  return (
    <div className={styles['root']} ref={rootRef}>
      <button
        type="button"
        className={cx(styles['trigger'], from === '' && styles['triggerEmpty'])}
        aria-label="From date"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleTriggerClick}
      >
        {from === '' ? 'From date' : from}
      </button>
      <span className={styles['sep']}>–</span>
      <button
        type="button"
        className={cx(styles['trigger'], to === '' && styles['triggerEmpty'])}
        aria-label="To date"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleTriggerClick}
      >
        {to === '' ? 'To date' : to}
      </button>
      {open && (
        <div className={styles['panel']} role="dialog" aria-label="Choose date range">
          <div className={styles['header']}>
            <button
              type="button"
              className={styles['navBtn']}
              aria-label="Previous month"
              onClick={() => navMonth(-1, false)}
            >
              ‹
            </button>
            <span className={styles['monthLabel']}>{monthLabel(view.year, view.month)}</span>
            <button
              type="button"
              className={styles['navBtn']}
              aria-label="Next month"
              onClick={() => navMonth(1, false)}
            >
              ›
            </button>
          </div>
          <div role="grid" onKeyDown={handleGridKeyDown}>
            <div role="row" className={styles['weekRow']}>
              {WEEKDAYS.map((w, i) => (
                <span key={i} role="columnheader" className={styles['weekday']}>
                  {w}
                </span>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div role="row" className={styles['weekRow']} key={week[0]?.iso ?? wi}>
                {week.map((cell) => {
                  const st = dayCellState(cell.iso, fromOrNull, toOrNull, todayIso);
                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      role="gridcell"
                      data-iso={cell.iso}
                      aria-label={cell.iso}
                      aria-selected={st.selected}
                      tabIndex={cell.iso === activeIso ? 0 : -1}
                      className={cx(
                        styles['cell'],
                        !cell.inMonth && styles['cellOutside'],
                        st.isToday && styles['cellToday'],
                        st.inRange && styles['cellInRange'],
                        st.selected && styles['cellSelected'],
                      )}
                      onClick={() => handleTap(cell.iso)}
                    >
                      {cell.day}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={styles['footer']}>
            <button
              type="button"
              className={styles['footerClear']}
              onClick={() => onChange('', '')}
            >
              Clear
            </button>
            <button
              type="button"
              className={styles['footerToday']}
              onClick={handleTodayClick}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
