// Pure .ts suite — deliberately NO JSX and NO DOM, so it stays out of the
// renderer suite's known jsx/lib-dom typecheck noise. Everything here must
// hold in ANY runner timezone: dates are built with the local Date
// constructor, never with fixed ISO strings.
import { describe, expect, it } from 'vitest';

import {
  addMonths,
  buildMonthGrid,
  dayCellState,
  formatIsoLocal,
  monthLabel,
  parseIsoToLocalDate,
  resolveRangeTap,
} from '../src/renderer/components/date-range-logic.js';

describe('formatIsoLocal / parseIsoToLocalDate', () => {
  it('roundtrips through local construction with single-digit padding', () => {
    expect(formatIsoLocal(new Date(2026, 0, 3))).toBe('2026-01-03');
    expect(formatIsoLocal(new Date(2026, 11, 31))).toBe('2026-12-31');
    const back = parseIsoToLocalDate('2026-07-05');
    expect(back).not.toBeNull();
    expect(formatIsoLocal(back!)).toBe('2026-07-05');
    // Local components, not UTC: the parsed date is midnight LOCAL.
    expect(back!.getFullYear()).toBe(2026);
    expect(back!.getMonth()).toBe(6);
    expect(back!.getDate()).toBe(5);
    expect(back!.getHours()).toBe(0);
  });

  it('rejects malformed input with null (strict two-digit shape)', () => {
    expect(parseIsoToLocalDate('')).toBeNull();
    expect(parseIsoToLocalDate('2026-7-1')).toBeNull();
    expect(parseIsoToLocalDate('2026-07-1')).toBeNull();
    expect(parseIsoToLocalDate('garbage')).toBeNull();
    expect(parseIsoToLocalDate('2026-07-05T00:00:00')).toBeNull();
  });
});

describe('buildMonthGrid — Monday-first full weeks', () => {
  it('July 2026 (starts Wednesday): 2 leading fillers, 35 cells, real adjacent isos', () => {
    // Anchor the premise itself: July 1, 2026 is a Wednesday.
    expect(new Date(2026, 6, 1).getDay()).toBe(3);
    const grid = buildMonthGrid(2026, 6);
    expect(grid.length).toBe(35);
    expect(grid.length % 7).toBe(0);
    // Leading fillers: Mon Jun 29, Tue Jun 30 — real dates, inMonth false.
    expect(grid[0]).toEqual({ iso: '2026-06-29', day: 29, inMonth: false });
    expect(grid[1]).toEqual({ iso: '2026-06-30', day: 30, inMonth: false });
    expect(grid[2]).toEqual({ iso: '2026-07-01', day: 1, inMonth: true });
    expect(grid[32]).toEqual({ iso: '2026-07-31', day: 31, inMonth: true });
    // Trailing fillers: Sat Aug 1, Sun Aug 2.
    expect(grid[33]).toEqual({ iso: '2026-08-01', day: 1, inMonth: false });
    expect(grid[34]).toEqual({ iso: '2026-08-02', day: 2, inMonth: false });
  });

  it('June 2026 (starts Monday): 0 leading fillers', () => {
    expect(new Date(2026, 5, 1).getDay()).toBe(1); // Monday — verified premise
    const grid = buildMonthGrid(2026, 5);
    expect(grid.length).toBe(35);
    expect(grid[0]).toEqual({ iso: '2026-06-01', day: 1, inMonth: true });
    // 30 days + 0 lead → 5 trailing fillers from July.
    expect(grid[29]).toEqual({ iso: '2026-06-30', day: 30, inMonth: true });
    expect(grid[30]).toEqual({ iso: '2026-07-01', day: 1, inMonth: false });
    expect(grid[34]).toEqual({ iso: '2026-07-05', day: 5, inMonth: false });
  });

  it('February 2027 (non-leap, starts Monday): exactly 28 cells, zero filler', () => {
    expect(new Date(2027, 1, 1).getDay()).toBe(1); // Monday — verified premise
    const grid = buildMonthGrid(2027, 1);
    expect(grid.length).toBe(28);
    expect(grid[0]).toEqual({ iso: '2027-02-01', day: 1, inMonth: true });
    expect(grid[27]).toEqual({ iso: '2027-02-28', day: 28, inMonth: true });
    expect(grid.every((c) => c.inMonth)).toBe(true);
  });

  it('length is always a multiple of 7 across a full year', () => {
    for (let m = 0; m < 12; m++) {
      expect(buildMonthGrid(2026, m).length % 7).toBe(0);
    }
  });
});

describe('monthLabel', () => {
  it('formats English month + year without locale APIs', () => {
    expect(monthLabel(2026, 6)).toBe('July 2026');
    expect(monthLabel(2027, 0)).toBe('January 2027');
    expect(monthLabel(2025, 11)).toBe('December 2025');
  });
});

describe('resolveRangeTap — two-tap state machine', () => {
  it('empty selection → tapped day becomes from', () => {
    expect(resolveRangeTap({ from: null, to: null }, '2026-07-10'))
      .toEqual({ from: '2026-07-10', to: null });
  });

  it('complete range → new tap starts a fresh range', () => {
    expect(resolveRangeTap({ from: '2026-07-10', to: '2026-07-20' }, '2026-07-15'))
      .toEqual({ from: '2026-07-15', to: null });
  });

  it('second tap after from → closes the range', () => {
    expect(resolveRangeTap({ from: '2026-07-10', to: null }, '2026-07-20'))
      .toEqual({ from: '2026-07-10', to: '2026-07-20' });
  });

  it('second tap before from → swap', () => {
    expect(resolveRangeTap({ from: '2026-07-10', to: null }, '2026-07-05'))
      .toEqual({ from: '2026-07-05', to: '2026-07-10' });
  });

  it('second tap on from itself → one-day range', () => {
    expect(resolveRangeTap({ from: '2026-07-10', to: null }, '2026-07-10'))
      .toEqual({ from: '2026-07-10', to: '2026-07-10' });
  });
});

describe('dayCellState', () => {
  const from = '2026-07-10';
  const to = '2026-07-20';
  const today = '2026-07-15';

  it('endpoints are selected, not inRange', () => {
    expect(dayCellState(from, from, to, today))
      .toEqual({ selected: true, inRange: false, isToday: false });
    expect(dayCellState(to, from, to, today))
      .toEqual({ selected: true, inRange: false, isToday: false });
  });

  it('interior day is inRange (and isToday composes independently)', () => {
    expect(dayCellState('2026-07-15', from, to, today))
      .toEqual({ selected: false, inRange: true, isToday: true });
    expect(dayCellState('2026-07-11', from, to, today))
      .toEqual({ selected: false, inRange: true, isToday: false });
  });

  it('outside days are neither selected nor inRange', () => {
    expect(dayCellState('2026-07-09', from, to, today))
      .toEqual({ selected: false, inRange: false, isToday: false });
    expect(dayCellState('2026-07-21', from, to, today))
      .toEqual({ selected: false, inRange: false, isToday: false });
  });

  it('open range (to null) has no interior', () => {
    expect(dayCellState('2026-07-15', from, null, today))
      .toEqual({ selected: false, inRange: false, isToday: true });
    expect(dayCellState(from, from, null, today))
      .toEqual({ selected: true, inRange: false, isToday: false });
  });
});

describe('addMonths — own arithmetic, no Date', () => {
  it('+1 across December rolls the year forward', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });

  it('-1 across January rolls the year back', () => {
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('±14 normalizes across year boundaries', () => {
    expect(addMonths(2026, 6, 14)).toEqual({ year: 2027, month: 8 });
    expect(addMonths(2026, 6, -14)).toEqual({ year: 2025, month: 4 });
  });

  it('delta 0 is identity', () => {
    expect(addMonths(2026, 6, 0)).toEqual({ year: 2026, month: 6 });
  });
});
