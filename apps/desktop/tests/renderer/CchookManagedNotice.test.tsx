// @vitest-environment jsdom
// The managed-externally notice: copy per reason, the resolved path only for a
// symlink, the snippet copied verbatim, and when it shows at all.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { COPIED_MS, CchookManagedNotice, managedNoticeToShow } from '../../src/renderer/components/CchookManagedNotice.js';
import type { CchookHooksCheck, CchookManagedSettings, CchookStatus } from '../../src/shared/types.js';

afterEach(cleanup);

const SNIPPET = JSON.stringify({ hooks: { Elicitation: [{ matcher: '*' }] } }, null, 2);
const SYMLINK: CchookManagedSettings = { reason: 'symlink', target: '/Users/you/dotfiles/claude/settings.json', snippet: SNIPPET };

describe('CchookManagedNotice', () => {
  it('symlink: title, text, the resolved path line, and Copy hook configuration copies the snippet', async () => {
    const copy = vi.fn(async () => undefined);
    render(<CchookManagedNotice managed={SYMLINK} copy={copy} />);
    expect(screen.getByText('Claude Code settings are managed externally')).toBeTruthy();
    expect(
      screen.getByText(
        "~/.claude/settings.json is a symlink, so xCLAUDE won't modify it automatically. Add the xCLAUDE hook configuration to the file or tool that manages your Claude Code settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('cchook-managed-target').textContent).toBe(
      '~/.claude/settings.json → /Users/you/dotfiles/claude/settings.json',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy hook configuration' }));
    expect(copy).toHaveBeenCalledWith(SNIPPET);
  });

  it('after copying, the button reads "Copied" for a few seconds, then goes back', async () => {
    vi.useFakeTimers();
    try {
      render(<CchookManagedNotice managed={SYMLINK} copy={async () => undefined} />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy hook configuration' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(COPIED_MS);
      });
      expect(screen.getByRole('button', { name: 'Copy hook configuration' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed copy does not claim "Copied"', async () => {
    render(<CchookManagedNotice managed={SYMLINK} copy={async () => Promise.reject(new Error('denied'))} />);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Copy hook configuration' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('not a regular file / another owner: their own text, no resolved path, same button', () => {
    for (const [reason, text] of [
      ['not_regular', /is not a regular file, so xCLAUDE won't modify it automatically/],
      ['foreign_owner', /is owned by another user account, so xCLAUDE won't modify it automatically/],
    ] as const) {
      render(<CchookManagedNotice managed={{ reason, snippet: SNIPPET }} />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByTestId('cchook-managed-target')).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy hook configuration' })).toBeTruthy();
      cleanup();
    }
  });

  it('nothing managed → nothing rendered', () => {
    render(<CchookManagedNotice managed={null} />);
    expect(screen.queryByTestId('cchook-managed-notice')).toBeNull();
  });
});

describe('managedNoticeToShow', () => {
  const base = { installed: true, hookRegistered: true, pendingSpool: 0, pendingNotice: null, lastCycle: null, unreadableTotal: 0, lastSessionStartTs: null };
  const outdated: CchookHooksCheck = { state: 'outdated', issues: [{ event: 'Elicitation', problem: 'missing' }] };
  const status = (over: Partial<CchookStatus>): CchookStatus => ({ ...base, ...over });

  it('installed and outdated on a managed file → shown (instead of Update hooks)', () => {
    expect(managedNoticeToShow(status({ settingsManaged: SYMLINK, hookCheck: outdated }), null)).toBe(SYMLINK);
  });

  it('managed but up to date, or never installed and no attempt → not shown', () => {
    expect(managedNoticeToShow(status({ settingsManaged: SYMLINK, hookCheck: { state: 'up_to_date' } }), null)).toBeNull();
    expect(managedNoticeToShow(status({ settingsManaged: SYMLINK, hookCheck: { state: 'not_installed' } }), null)).toBeNull();
  });

  it('after an attempt that wrote nothing → shown, until the poll says the file is no longer managed', () => {
    expect(managedNoticeToShow(status({ settingsManaged: SYMLINK, hookCheck: { state: 'not_installed' } }), SYMLINK)).toBe(SYMLINK);
    expect(managedNoticeToShow(status({ settingsManaged: null }), SYMLINK)).toBeNull();
  });

  it('a regular file → never', () => {
    expect(managedNoticeToShow(status({ settingsManaged: null, hookCheck: outdated }), null)).toBeNull();
  });
});
