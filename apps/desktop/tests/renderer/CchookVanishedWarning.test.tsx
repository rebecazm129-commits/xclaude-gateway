// @vitest-environment jsdom
// Hook-integrity notice: the Claude Code capture hook vanished from
// ~/.claude/settings.json out-of-band. Component tests only — the edge
// detection lives in main (tests/main/cchook-integrity.test.ts); this banner
// just renders the persisted pendingNotice and forwards both actions.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CchookVanishedWarning } from '../../src/renderer/components/CchookVanishedWarning.js';

afterEach(cleanup);

const NOTICE = { ts: '2026-08-14T10:00:00.000Z' };

describe('CchookVanishedWarning', () => {
  it('renders nothing without a notice', () => {
    const { container } = render(
      <CchookVanishedWarning notice={null} onReinstall={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the fixed copy as a status region', () => {
    render(<CchookVanishedWarning notice={NOTICE} onReinstall={vi.fn()} onDismiss={vi.fn()} />);
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Claude Code hook removed outside xCLAUDE');
    expect(region.textContent).toContain(
      'The Claude Code hook was removed outside xCLAUDE Gateway. Claude Code activity is no longer audited.',
    );
  });

  it('Reinstall fires onReinstall without dismissing', () => {
    const onReinstall = vi.fn();
    const onDismiss = vi.fn();
    render(
      <CchookVanishedWarning notice={NOTICE} onReinstall={onReinstall} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reinstall hook' }));
    expect(onReinstall).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Dismiss fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(<CchookVanishedWarning notice={NOTICE} onReinstall={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Claude Code hook notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
