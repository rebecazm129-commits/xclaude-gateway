// Pure calendar logic for the DateRangePicker (no React, no DOM). Wire format
// stays 'YYYY-MM-DD' — the DetectionFilter.customRange contract, local-day
// semantics since d6926da. INVARIANT: calendar dates are NEVER built with
// Date.parse('YYYY-MM-DD') (UTC midnight per ECMAScript spec) nor serialized
// with toISOString() (UTC re-shift) — always new Date(y, m, d) local
// construction and manual padStart formatting.

export type DayCell = {
  readonly iso: string; // 'YYYY-MM-DD'
  readonly day: number; // 1–31
  readonly inMonth: boolean; // false for leading/trailing filler days
};

// UI is English-only by design — no toLocaleDateString: the app must not
// depend on the OS locale.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function formatIsoLocal(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Strict shape only (same regex family as parseLocalDayStart in the main
// process); anything else → null. Date normalizes out-of-range month/day —
// input comes from this module's own iso strings.
export function parseIsoToLocalDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Full-week grid, MONDAY-first (mockup): from the Monday ≤ the 1st of the
// month to the Sunday ≥ its last day. Length is always a multiple of 7
// (28/35/42). Filler days carry inMonth: false and their REAL iso — they are
// navigable/selectable like any other day.
export function buildMonthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  // Monday-first offset: getDay() is Sun=0..Sat=6 → Mon=0..Sun=6.
  const lead = (first.getDay() + 6) % 7;
  // Day 0 of the next month = last day of this one.
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const cells: DayCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(year, month, 1 - lead + i);
    cells.push({
      iso: formatIsoLocal(d),
      day: d.getDate(),
      inMonth:
        d.getMonth() === first.getMonth() && d.getFullYear() === first.getFullYear(),
    });
  }
  return cells;
}

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

// Two-tap range state machine. ISO strings of equal shape compare correctly
// as plain strings — no Date round-trip needed.
export function resolveRangeTap(
  current: { from: string | null; to: string | null },
  tappedIso: string,
): { from: string | null; to: string | null } {
  // No selection yet, or a complete range → start a fresh one.
  if (current.from === null || current.to !== null) {
    return { from: tappedIso, to: null };
  }
  // Second tap before the anchor → swap. Same day falls through to a
  // one-day range ({from, to: from}).
  if (tappedIso < current.from) {
    return { from: tappedIso, to: current.from };
  }
  return { from: current.from, to: tappedIso };
}

export function dayCellState(
  iso: string,
  from: string | null,
  to: string | null,
  todayIso: string,
): { selected: boolean; inRange: boolean; isToday: boolean } {
  return {
    selected: iso === from || iso === to,
    // Strictly between the endpoints (the endpoints themselves are selected).
    inRange: from !== null && to !== null && iso > from && iso < to,
    isToday: iso === todayIso,
  };
}

// Own arithmetic, no Date: flatten to a month count so negative deltas and
// multi-year jumps normalize in one step (Math.floor is correct for
// negatives; the double-mod keeps month in 0–11).
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}
