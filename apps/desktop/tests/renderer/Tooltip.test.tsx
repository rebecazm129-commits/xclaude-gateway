// @vitest-environment jsdom
// Tooltip primitive (F2.4 commit 5l) — including the regression that killed
// the native title on the Session chip (commit 5k): the tooltip must appear
// even when the wrapped child re-renders mid-delay (live (n/m) label churn),
// because the timer lives in the wrapper's state, not in the hovered element.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Tooltip } from '../../src/renderer/components/Tooltip.js';

afterEach(cleanup);

describe('Tooltip', () => {
  it('appears after the delay on hover and hides on leave', async () => {
    render(
      <Tooltip text="hello tip">
        <button type="button">Chip</button>
      </Tooltip>,
    );
    const wrap = screen.getByRole('button').parentElement!;
    fireEvent.mouseEnter(wrap);
    // Not instant — the 300ms delay gates it.
    expect(screen.queryByRole('tooltip')).toBeNull();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('hello tip');
    fireEvent.mouseLeave(wrap);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('SURVIVES a child re-render mid-delay (the commit-5k Session bug)', async () => {
    const { rerender } = render(
      <Tooltip text="session tip">
        <button type="button">Session (1/1)</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole('button').parentElement!);
    // Live poll churn mutates the chip label BEFORE the delay elapses — the
    // native title restarts the OS timer here and never fires; ours must.
    rerender(
      <Tooltip text="session tip">
        <button type="button">Session (2/2)</button>
      </Tooltip>,
    );
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('session tip');
  });

  it('keyboard: shows on focus, hides on blur, wires aria-describedby', async () => {
    render(
      <Tooltip text="kb tip">
        <button type="button">Chip</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    const tip = await screen.findByRole('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.blur(btn);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
