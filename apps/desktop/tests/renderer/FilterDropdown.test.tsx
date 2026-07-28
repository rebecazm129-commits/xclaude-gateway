// @vitest-environment jsdom
// Component tests for FilterDropdown's All/None footer (restyling 28/07) and
// the individual checkbox toggling that must survive it. CSS modules are not
// processed under vitest, so assertions are by testid/label, never styles.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FilterDropdown } from '../../src/renderer/components/FilterDropdown.js';

afterEach(cleanup);

const OPTIONS = ['low', 'medium', 'high'] as const;

function renderOpen(onChange = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <FilterDropdown
      label="Severity"
      options={OPTIONS}
      selected={['low']}
      onChange={onChange}
      isOpen={true}
      onToggle={() => {}}
    />,
  );
  return onChange;
}

describe('FilterDropdown — All/None footer', () => {
  it('(a) All → onChange with every option', () => {
    const onChange = renderOpen();
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(onChange).toHaveBeenCalledWith(['low', 'medium', 'high']);
  });

  it('(b) None → onChange([])', () => {
    const onChange = renderOpen();
    fireEvent.click(screen.getByTestId('filter-none'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('(c) individual checkboxes keep toggling', () => {
    const onChange = renderOpen();
    // Check an unchecked one: joins the selection (stable options order).
    fireEvent.click(screen.getByLabelText('medium'));
    expect(onChange).toHaveBeenCalledWith(['low', 'medium']);
    // Uncheck the selected one (parent-controlled: selected is still ['low']).
    fireEvent.click(screen.getByLabelText('low'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
