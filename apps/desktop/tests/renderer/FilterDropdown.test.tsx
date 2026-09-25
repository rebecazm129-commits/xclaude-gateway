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

describe('FilterDropdown — a chip with one option', () => {
  function renderChip(options: readonly string[], selected: readonly string[]): void {
    render(
      <FilterDropdown
        label="Section"
        options={options}
        selected={selected}
        onChange={() => {}}
        isOpen={false}
        onToggle={() => {}}
      />,
    );
  }

  it('is hidden: "Section (1/1)" filters nothing', () => {
    renderChip(['tools'], ['tools']);
    expect(screen.queryByRole('button', { name: /Section/ })).toBeNull();
  });

  it('is hidden with no options at all', () => {
    renderChip([], []);
    expect(screen.queryByRole('button', { name: /Section/ })).toBeNull();
  });

  it('comes back as soon as a second option exists', () => {
    renderChip(['tools', 'prompts'], ['tools', 'prompts']);
    expect(screen.getByRole('button', { name: /Section \(2\/2\)/ })).toBeDefined();
  });

  it('stays visible while it is narrowing, so a selection never vanishes with its way back', () => {
    // The inventory shrank to one option under an active selection of a value
    // that is no longer in it (a time window moved, say).
    renderChip(['tools'], ['prompts']);
    expect(screen.getByRole('button', { name: /Section/ })).toBeDefined();
  });
});
