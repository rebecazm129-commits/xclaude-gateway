// @vitest-environment jsdom
// Marking a change reviewed. The write reads the whole trail before it appends
// — seconds on a real install — so the click cannot wait for it: the row, the
// panel and the cards move at once, the button waits, and a failed write puts
// everything back and says so.

(globalThis as any).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Changes } from '../../src/renderer/components/Changes.js';
import { scenarioById } from '../../src/renderer/harness/fixtures.js';
import type { ConnectorChangeView } from '../../src/renderer/lib/xcgApi.js';

afterEach(cleanup);

const settle = async (): Promise<void> => {
  await act(() => new Promise<void>((r) => setTimeout(r, 60)));
};
const cards = (): HTMLElement[] =>
  screen.getAllByRole('button').filter((b) => b.className.includes('card'));
const cardText = (label: string): string => cards().find((c) => c.textContent?.includes(label))?.textContent ?? '';
const rowNodes = (): HTMLElement[] => screen.queryAllByRole('button').filter((b) => b.className.includes('row'));
const reviewButton = (): HTMLButtonElement =>
  [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((b) =>
    /Mark|Marking|Unmarking/.test(b.textContent ?? ''),
  ) as HTMLButtonElement;

/** A trail the mock owns: a successful write changes what the next read returns. */
function mount(write: (id: string, to: 'reviewed' | 'unreviewed') => Promise<void>) {
  const trail: ConnectorChangeView[] = (scenarioById('needs-review').changes ?? []).map((c) => ({ ...c }));
  const setReviewStatus = vi.fn(async (id: string, to: 'reviewed' | 'unreviewed') => {
    await write(id, to);
    const row = trail.find((r) => r.event_id === id);
    if (row !== undefined) row.review_status = to;
  });
  const connectorChanges = vi.fn(async () => trail.map((c) => ({ ...c })));
  (window as unknown as { xcg: unknown }).xcg = {
    connectorChanges,
    setReviewStatus,
    exportChanges: vi.fn(async () => ({ ok: true, count: 0 })),
    openAuditFolder: vi.fn(),
  };
  render(<Changes />);
  return { setReviewStatus, connectorChanges };
}

async function openGmail(): Promise<void> {
  await settle();
  fireEvent.click(rowNodes().find((r) => r.textContent?.includes('gmail'))!);
  await settle();
}

describe('Mark as reviewed', () => {
  it('moves at the click, waits for the write, then settles on the trail', async () => {
    let release!: () => void;
    const { setReviewStatus, connectorChanges } = mount(() => new Promise<void>((r) => (release = r)));
    await openGmail();
    expect(cardText('Needs review')).toBe('5Needs review');
    const readsBefore = connectorChanges.mock.calls.length;

    fireEvent.click(reviewButton());

    // The call, and the button waiting on it.
    expect(setReviewStatus).toHaveBeenCalledWith('evt-bcc', 'reviewed');
    expect(reviewButton().textContent).toBe('Marking…');
    expect(reviewButton().disabled).toBe(true);
    // The count moved already, before the write settled.
    expect(cardText('Needs review')).toBe('4Needs review');
    // A second click while it writes does nothing.
    fireEvent.click(reviewButton());
    expect(setReviewStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    await settle();
    expect(reviewButton().textContent).toBe('Mark as unreviewed');
    expect(reviewButton().disabled).toBe(false);
    expect(connectorChanges.mock.calls.length).toBeGreaterThan(readsBefore); // re-read in the background
    expect(cardText('Needs review')).toBe('4Needs review');
  });

  it('a failed write puts everything back and says so in the panel', async () => {
    let fail!: () => void;
    mount(() => new Promise<void>((_, reject) => (fail = () => reject(new Error('disk')))));
    await openGmail();
    fireEvent.click(reviewButton());
    expect(cardText('Needs review')).toBe('4Needs review');

    await act(async () => {
      fail();
    });
    await settle();
    expect(cardText('Needs review')).toBe('5Needs review');
    expect(reviewButton().textContent).toBe('Mark as reviewed');
    expect(reviewButton().disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe("Couldn't save the review status. Try again.");
  });

  it('unmarking says so while it writes', async () => {
    let release!: () => void;
    mount(() => new Promise<void>((r) => (release = r)));
    await openGmail();
    fireEvent.click(reviewButton());
    await act(async () => {
      release();
    });
    await settle();
    fireEvent.click(reviewButton());
    expect(reviewButton().textContent).toBe('Unmarking…');
    await act(async () => {
      release();
    });
  });
});

describe('which card reads as the filter', () => {
  const active = (): string[] => cards().filter((c) => c.className.includes('cardActive')).map((c) => c.textContent ?? '');

  it('opening the tab (the Needs review only chip) shows Needs review, not Total', async () => {
    mount(async () => undefined);
    await settle();
    expect(active()).toEqual(['5Needs review']);
  });

  it('lifting the chip shows Total', async () => {
    mount(async () => undefined);
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    expect(active().map((t) => t.replace(/^\d+/, ''))).toEqual(['Total']);
  });

  it('a pressed severity card is the only one shown', async () => {
    mount(async () => undefined);
    await settle();
    fireEvent.click(cards().find((c) => c.textContent?.includes('High'))!);
    await settle();
    expect(active().map((t) => t.replace(/^\d+/, ''))).toEqual(['High']);
  });
});
