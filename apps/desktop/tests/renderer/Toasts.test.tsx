// @vitest-environment jsdom
// Toasts: one polite live region above the audit footer; the spool-drop toast
// stays until Dismiss, only "Hooks updated" closes on its own.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  TOAST_AUTO_CLOSE_MS,
  TOAST_BOTTOM_PX,
  ToastStack,
  droppedToastText,
  type ToastItem,
} from '../../src/renderer/components/Toasts.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dropped = (onAction = vi.fn()): ToastItem => ({
  id: 'spool-dropped',
  kind: 'warning',
  text: droppedToastText(37),
  persistent: true,
  actionLabel: 'Dismiss',
  onAction,
});
const updated = (onClose = vi.fn()): ToastItem => ({ id: 'hooks-updated', kind: 'success', text: 'Hooks updated', onClose });

describe('ToastStack', () => {
  it('is one polite live region, mounted even when empty, so what is added gets announced', () => {
    const { rerender } = render(<ToastStack toasts={[]} />);
    const region = screen.getByTestId('toast-stack');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    rerender(<ToastStack toasts={[updated()]} />);
    expect(screen.getByTestId('toast-stack')).toBe(region);
    expect(region.textContent).toContain('Hooks updated');
    // No nested live regions inside the stack.
    expect(region.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  });

  it('sits above the audit footer (~53px), never over it', () => {
    render(<ToastStack toasts={[dropped()]} />);
    expect(TOAST_BOTTOM_PX).toBeGreaterThan(53);
    expect(screen.getByTestId('toast-stack').style.bottom).toBe(`${TOAST_BOTTOM_PX}px`);
  });

  it('the spool-drop toast persists — no timer closes it — until Dismiss', () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    render(<ToastStack toasts={[dropped(onAction)]} />);
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(screen.getByText("37 Claude Code events weren't recorded because the staging area reached its limit.")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('Dismiss is a real, focusable button (keyboard: Tab to it, Enter/Space)', () => {
    render(<ToastStack toasts={[dropped()]} />);
    const button = screen.getByRole('button', { name: 'Dismiss' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('only "Hooks updated" closes on its own, after 4 s', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<ToastStack toasts={[dropped(), updated(onClose)]} />);
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS - 1);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(TOAST_AUTO_CLOSE_MS).toBe(4_000);
  });

  it('one dropped event: singular', () => {
    expect(droppedToastText(1)).toBe("1 Claude Code event wasn't recorded because the staging area reached its limit.");
  });
});
