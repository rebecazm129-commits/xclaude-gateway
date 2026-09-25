// @vitest-environment jsdom
// The MCP changes tab. Two of these exist because the behaviour was wrong the
// first time and a sentence in a commit message would not have caught it
// again.

(globalThis as any).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Changes } from '../../src/renderer/components/Changes.js';
import { scenarioById } from '../../src/renderer/harness/fixtures.js';

afterEach(cleanup);

function mount(scenarioId: string): void {
  const scenario = scenarioById(scenarioId);
  (window as unknown as { xcg: unknown }).xcg = {
    connectorChanges: vi.fn(async () => scenario.changes ?? []),
    setReviewStatus: vi.fn(async () => undefined),
    exportChanges: vi.fn(async () => ({ ok: true, count: 0 })),
    openAuditFolder: vi.fn(),
  };
  render(<Changes />);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
const cardTexts = (): string[] =>
  screen.getAllByRole('button').filter((b) => b.className.includes('card')).map((b) => b.textContent ?? '');
const rowNodes = (): HTMLElement[] =>
  screen.queryAllByRole('button').filter((b) => b.className.includes('row'));

describe('MCP changes — the default view', () => {
  it('opens on Needs review, not on every change ever recorded', async () => {
    // The tab exists to answer "what still wants a look?". Opening on eleven
    // rows, four months of vendor edits included, answers a different one.
    mount('needs-review');
    await settle();
    expect(screen.getByText('Needs review only').closest('button')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(rowNodes()).toHaveLength(5);
  });

  it('the five cards count the axis this tab has, not the severity axis', () => {
    // WITH FINDINGS and NEEDS REVIEW sit where LOW and CRITICAL would: no rule
    // produces critical for a manifest change, and low is not what a change
    // with no finding is.
    mount('needs-review');
    return settle().then(() => {
      expect(cardTexts()).toEqual([
        '12Total',
        '4With findings',
        '1Medium',
        '2High',
        '5Needs review',
      ]);
    });
  });
});

describe('MCP changes — the detail panel', () => {
  it('shows a short list outright instead of folding it behind "Show more"', async () => {
    // It used to fold every unflagged item, so a change touching two tools and
    // flagging neither rendered an empty section above "Show 2 more": no
    // information plus a click to get any.
    mount('all-changes');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    const drive = rowNodes().find((r) => r.textContent?.includes('drive'));
    expect(drive, 'the drive change should be listed').toBeDefined();
    fireEvent.click(drive!);
    await settle();
    const panel = document.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(/Show \d+ more/.test(text), 'a three-item list must not be folded').toBe(false);
    expect((text.match(/file:\/\/\//g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('offers Mark as reviewed on a change that raised nothing', async () => {
    // Every change can be signed off, not only the ones a rule flagged.
    mount('all-changes');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    fireEvent.click(rowNodes().find((r) => r.textContent?.includes('drive'))!);
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Mark as reviewed');
  });
});
