// @vitest-environment jsdom
// DOM tests for the Modal shell: open/close affordances (✕, Esc, scrim click)
// and focus-on-mount. Opts into jsdom via the pragma above; the rest of the
// suite stays in the default 'node' environment (see vitest.config.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Modal } from '../../src/renderer/components/Modal.js';

afterEach(cleanup);

function renderModal(onClose: () => void = vi.fn()): {
  onClose: () => void;
  container: HTMLElement;
} {
  const { container } = render(
    <Modal title="Add connector" onClose={onClose}>
      <p>body content</p>
    </Modal>,
  );
  return { onClose, container };
}

describe('Modal', () => {
  it('renders the title and children', () => {
    renderModal();
    expect(screen.getByText('Add connector')).toBeDefined();
    expect(screen.getByText('body content')).toBeDefined();
  });

  it('focuses the panel on mount', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('closes when the ✕ button is clicked', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a mousedown on the scrim (outside the panel)', () => {
    const onClose = vi.fn();
    const { container } = renderModal(onClose);
    // container.firstChild is the scrim; pressing on it (not the panel) closes.
    fireEvent.mouseDown(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a mousedown inside the panel', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders an optional pinned footer', () => {
    render(
      <Modal title="t" onClose={vi.fn()} footer={<span>foot text</span>}>
        x
      </Modal>,
    );
    expect(screen.getByText('foot text')).toBeDefined();
  });
});
