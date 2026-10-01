// @vitest-environment jsdom
// The informational notice for a ~/.claude-* profile without the hook: its
// words, the muted scope line, the snippet copied verbatim, and Dismiss.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CchookProfileNotice } from '../../src/renderer/components/CchookProfileNotice.js';

afterEach(cleanup);

const PROFILE = { path: '~/.claude-work', snippet: JSON.stringify({ hooks: { Stop: [] } }, null, 2) };

describe('CchookProfileNotice', () => {
  it('title, body with the path, the scope line, Copy and Dismiss', () => {
    render(<CchookProfileNotice profile={PROFILE} onDismiss={() => {}} copy={async () => undefined} />);
    expect(screen.getByText('Another Claude Code profile may not be audited')).toBeTruthy();
    expect(
      screen.getByText(
        'xCLAUDE found ~/.claude-work/settings.json without its hook. If you use this profile, add the xCLAUDE hook configuration manually.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('xCLAUDE installs hooks automatically only in ~/.claude.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Copy hook configuration', 'Dismiss']);
  });

  it('Copy hook configuration copies the snippet verbatim', async () => {
    const copy = vi.fn(async () => undefined);
    render(<CchookProfileNotice profile={PROFILE} onDismiss={() => {}} copy={copy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy hook configuration' }));
    expect(copy).toHaveBeenCalledWith(PROFILE.snippet);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('Dismiss reports this folder\'s path', () => {
    const onDismiss = vi.fn();
    render(<CchookProfileNotice profile={PROFILE} onDismiss={onDismiss} copy={async () => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('~/.claude-work');
  });

  it('neutral, not the orange warning panel', () => {
    render(<CchookProfileNotice profile={PROFILE} onDismiss={() => {}} copy={async () => undefined} />);
    const el = screen.getByTestId('cchook-profile-notice');
    expect(el.className).not.toMatch(/warning/);
  });
});
