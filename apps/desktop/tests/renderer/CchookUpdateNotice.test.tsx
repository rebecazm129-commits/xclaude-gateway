// @vitest-environment jsdom
// The Claude Code tab's update notice: neutral and compact, Update hooks or
// Not now (until the set of pending changes differs), a short "Hooks
// updated." afterwards, and a custom hook path reported without a button to
// replace it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CchookUpdateNotice, UPDATED_MS } from '../../src/renderer/components/CchookUpdateNotice.js';
import { hookUpdateDismissed, hookUpdateKey } from '../../src/shared/types.js';
import type { CchookHooksCheck, HookUpdatePrefs } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OUTDATED: CchookHooksCheck = {
  state: 'outdated',
  issues: [
    { event: 'ElicitationResult', problem: 'missing' },
    { event: 'Elicitation', problem: 'missing' },
  ],
};
const KEY = 'Elicitation:missing,ElicitationResult:missing';
const CUSTOM_ONLY: CchookHooksCheck = { state: 'outdated', issues: [{ event: 'SessionStart', problem: 'custom_path' }] };
const TEXT = "Update xCLAUDE's hooks to record when MCP servers request input from you. A backup is created first.";
const CUSTOM =
  "A custom xCLAUDE hook path was found. xCLAUDE won't replace it automatically. Update it manually or reinstall the hook from Sources.";

function renderNotice(
  check: CchookHooksCheck | undefined,
  over: Partial<Parameters<typeof CchookUpdateNotice>[0]> = {},
) {
  const handlers = { onUpdate: vi.fn(), onNotNow: vi.fn(), onDismissUpdated: vi.fn() };
  render(<CchookUpdateNotice check={check} prefs={undefined} updated={false} error={null} {...handlers} {...over} />);
  return handlers;
}

describe('hookUpdateKey', () => {
  it('the sorted set of fixable changes; a custom path is not part of it', () => {
    expect(hookUpdateKey(OUTDATED)).toBe(KEY);
    expect(hookUpdateKey(CUSTOM_ONLY)).toBe('');
    expect(hookUpdateKey({ state: 'up_to_date' })).toBe('');
  });
});

describe('CchookUpdateNotice', () => {
  it('outdated: title, text, the muted note, Update hooks and Not now — nothing else', () => {
    const h = renderNotice(OUTDATED);
    expect(screen.getByText('New Claude Code coverage available')).toBeTruthy();
    expect(screen.getByText(TEXT)).toBeTruthy();
    expect(screen.getByText('Only xCLAUDE-managed entries are changed.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Update hooks', 'Not now']);
    expect(screen.queryByText('Remind me later')).toBeNull();
    expect(screen.queryByText('Skip this update')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update hooks' }));
    expect(h.onUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.onNotNow).toHaveBeenCalledWith(KEY);
  });

  it('only in outdated: not for up_to_date, not_installed, or before the first poll', () => {
    for (const check of [{ state: 'up_to_date' } as const, { state: 'not_installed' } as const, undefined]) {
      renderNotice(check);
      expect(screen.queryByTestId('cchook-update-notice')).toBeNull();
      cleanup();
    }
  });

  it('Not now hides it for this set of changes — with no end — and it comes back only for another set', () => {
    const prefs: HookUpdatePrefs = { notNowKey: KEY };
    expect(hookUpdateDismissed(prefs, KEY)).toBe(true);
    renderNotice(OUTDATED, { prefs });
    expect(screen.queryByTestId('cchook-update-notice')).toBeNull();
    cleanup();
    const more: CchookHooksCheck = { state: 'outdated', issues: [...OUTDATED.issues, { event: 'SessionEnd', problem: 'not_async' }] };
    renderNotice(more, { prefs });
    expect(screen.getByRole('button', { name: 'Update hooks' })).toBeTruthy();
  });

  it('after the update: a short "Hooks updated." that goes away on its own', () => {
    vi.useFakeTimers();
    const h = renderNotice({ state: 'up_to_date' }, { updated: true });
    expect(screen.getByTestId('cchook-update-notice').textContent).toBe('Hooks updated.');
    expect(screen.queryByRole('button')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(UPDATED_MS - 1);
    });
    expect(h.onDismissUpdated).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(h.onDismissUpdated).toHaveBeenCalledTimes(1);
  });

  it('custom hook path only: the custom text, and no button that would replace it', () => {
    renderNotice(CUSTOM_ONLY);
    expect(screen.getByText(CUSTOM)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update hooks' })).toBeNull();
  });

  it('a failed update shows its error next to the actions', () => {
    renderNotice(OUTDATED, { error: 'Claude Code settings changed while xCLAUDE was updating them. Try again.' });
    expect(screen.getByText('Claude Code settings changed while xCLAUDE was updating them. Try again.')).toBeTruthy();
  });
});
