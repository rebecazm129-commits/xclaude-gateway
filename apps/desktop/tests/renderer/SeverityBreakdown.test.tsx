// @vitest-environment jsdom
// The counter cards as buttons: each says whether it is the current filter,
// to a screen reader as well as to the eye.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SeverityBreakdown, severityCards, type BreakdownCard } from '../../src/renderer/components/SeverityBreakdown.js';

afterEach(cleanup);

const card = (key: string, active: boolean, inactive = false): BreakdownCard => ({
  key,
  label: key,
  count: 1,
  active,
  inactive,
  onSelect: vi.fn(),
});
const pressedOf = (label: string): string | null =>
  screen.getByRole('button', { name: new RegExp(label) }).getAttribute('aria-pressed');

describe('SeverityBreakdown — aria-pressed follows the active state', () => {
  it('the active card is pressed, every other card is not', () => {
    render(
      <SeverityBreakdown
        cards={[card('total', false, true), card('needsreview', true), card('medium', false, true), card('high', false, true)]}
      />,
    );
    expect(pressedOf('needsreview')).toBe('true');
    expect(pressedOf('total')).toBe('false');
    expect(pressedOf('medium')).toBe('false');
    expect(pressedOf('high')).toBe('false');
  });

  it('the Detections axis: Total pressed when every severity is selected, one severity when it alone is', () => {
    const base = { counts: { low: 1, medium: 2, high: 3, critical: 4 }, total: 10, totalSeverityOptionsCount: 4, onSelectTotal: vi.fn(), onSelectSeverity: vi.fn() };
    render(<SeverityBreakdown cards={severityCards({ ...base, selectedSeverities: ['low', 'medium', 'high', 'critical'] })} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    cleanup();
    render(<SeverityBreakdown cards={severityCards({ ...base, selectedSeverities: ['high'] })} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false']);
  });
});
