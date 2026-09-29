// @vitest-environment jsdom
// The compact hook-update card: title, line, Update hooks / Not now; Not now
// hides it until the set of pending changes differs; a custom hook path is
// reported without a button to replace it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CchookUpdateCard } from '../../src/renderer/components/CchookUpdateCard.js';
import { hookUpdateDismissed, hookUpdateKey } from '../../src/shared/types.js';
import type { CchookHooksCheck, HookUpdatePrefs } from '../../src/shared/types.js';

afterEach(cleanup);

const OUTDATED: CchookHooksCheck = {
  state: 'outdated',
  issues: [
    { event: 'ElicitationResult', problem: 'missing' },
    { event: 'Elicitation', problem: 'missing' },
  ],
};
const KEY = 'Elicitation:missing,ElicitationResult:missing';
const CUSTOM_ONLY: CchookHooksCheck = { state: 'outdated', issues: [{ event: 'SessionStart', problem: 'custom_path' }] };

function renderCard(check: CchookHooksCheck | undefined, over: Partial<Parameters<typeof CchookUpdateCard>[0]> = {}) {
  const handlers = { onUpdate: vi.fn(), onNotNow: vi.fn() };
  render(<CchookUpdateCard check={check} prefs={undefined} error={null} {...handlers} {...over} />);
  return handlers;
}

describe('hookUpdateKey', () => {
  it('the sorted set of fixable changes; a custom path is not part of it', () => {
    expect(hookUpdateKey(OUTDATED)).toBe(KEY);
    expect(hookUpdateKey(CUSTOM_ONLY)).toBe('');
    expect(hookUpdateKey({ state: 'up_to_date' })).toBe('');
  });
});

describe('CchookUpdateCard', () => {
  it('title, line, Update hooks and Not now — nothing else', () => {
    const h = renderCard(OUTDATED);
    expect(screen.getByText('New Claude Code coverage available')).toBeTruthy();
    expect(screen.getByText('Record when MCP servers request input from you. A backup is created first.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Update hooks', 'Not now']);
    fireEvent.click(screen.getByRole('button', { name: 'Update hooks' }));
    expect(h.onUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.onNotNow).toHaveBeenCalledWith(KEY);
  });

  it('only when outdated: not for up_to_date, not_installed, or before the first poll', () => {
    for (const check of [{ state: 'up_to_date' } as const, { state: 'not_installed' } as const, undefined]) {
      renderCard(check);
      expect(screen.queryByTestId('cchook-update-card')).toBeNull();
      cleanup();
    }
  });

  it('Not now hides it for this set of changes, and it comes back only for another set', () => {
    const prefs: HookUpdatePrefs = { notNowKey: KEY };
    expect(hookUpdateDismissed(prefs, KEY)).toBe(true);
    renderCard(OUTDATED, { prefs });
    expect(screen.queryByTestId('cchook-update-card')).toBeNull();
    cleanup();
    const more: CchookHooksCheck = { state: 'outdated', issues: [...OUTDATED.issues, { event: 'SessionEnd', problem: 'not_async' }] };
    renderCard(more, { prefs });
    expect(screen.getByRole('button', { name: 'Update hooks' })).toBeTruthy();
  });

  it('custom hook path only: the custom text, and no button that would replace it', () => {
    renderCard(CUSTOM_ONLY);
    expect(
      screen.getByText(
        "A custom xCLAUDE hook path was found. xCLAUDE won't replace it automatically. Update it manually or reinstall the hook from Sources.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update hooks' })).toBeNull();
  });

  it('a failed update shows its error in the card', () => {
    renderCard(OUTDATED, { error: 'Claude Code settings changed while xCLAUDE was updating them. Try again.' });
    expect(screen.getByText('Claude Code settings changed while xCLAUDE was updating them. Try again.')).toBeTruthy();
  });
});
