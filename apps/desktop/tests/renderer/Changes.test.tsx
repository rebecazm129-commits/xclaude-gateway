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

  it('the four cards count the axis this tab has, not the severity axis', () => {
    // ALL CHANGES first, as TOTAL is in the sibling tabs; then NEEDS REVIEW,
    // then the severities rising. No CRITICAL (no rule produces it for a
    // manifest change) and no LOW. ALL CHANGES leaves the two historical
    // changes out: 12 recorded, 10 in view.
    mount('needs-review');
    return settle().then(() => {
      expect(cardTexts()).toEqual(['10All changes', '5Needs review', '1Medium', '2High']);
    });
  });

  it('opening the tab dims no card: the default filter is the chip, not a card', async () => {
    mount('needs-review');
    await settle();
    const cards = (): HTMLElement[] =>
      screen.getAllByRole('button').filter((b) => b.className.includes('card'));
    expect(cards().filter((c) => c.className.includes('cardInactive'))).toHaveLength(0);
    // Pressing a card is what dims the others, as in Detections…
    fireEvent.click(cards().find((c) => c.textContent?.endsWith('Medium'))!);
    await settle();
    expect(cards().filter((c) => c.className.includes('cardInactive'))).toHaveLength(3);
    // …and pressing it again lets go.
    fireEvent.click(cards().find((c) => c.textContent?.endsWith('Medium'))!);
    await settle();
    expect(cards().filter((c) => c.className.includes('cardInactive'))).toHaveLength(0);
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
    expect(/Show \d+ more/.test(text), 'a short list must not be folded').toBe(false);
    // One line per ITEM: file:///shared/index had two kinds of change and is
    // one line saying both, not two lines.
    expect(text).toContain('file:///shared/old-report — Removed');
    expect(text).toContain('file:///shared/index — Description changed; schema changed');
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

describe('MCP changes — the previous format', () => {
  // Recorded before rules and review existed. They are NOT marked reviewed to
  // get them out of the way — nobody reviewed them — they are an unchecked
  // option of the Status filter, and stay in the trail and the export.
  const openStatus = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
  };

  it('is an unchecked Status option, and out of the counts and the list', async () => {
    mount('historical');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    expect(rowNodes()).toHaveLength(0);
    expect(cardTexts()).toEqual(['0All changes', '0Needs review', '0Medium', '0High']);
    // No note in the chips row any more: the Status filter is the way in.
    expect(screen.queryByRole('button', { name: /historical change/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Status \(2\/3\)/ })).toBeDefined();

    openStatus();
    const previous = screen.getByLabelText('Previous format') as HTMLInputElement;
    expect(previous.checked).toBe(false);
    fireEvent.click(previous);
    await settle();
    expect(rowNodes()).toHaveLength(2);
    expect(cardTexts()).toContain('2All changes');
  });

  it('with nothing else recorded, the empty state points at the Status filter', async () => {
    // "Nothing needs review" would be true and useless: the trail holds
    // changes, just none in the current format.
    mount('historical');
    await settle();
    expect(document.body.textContent).toContain(
      'No new changes. Older changes in the previous format are available in the Status filter.',
    );
    expect(screen.queryByRole('button', { name: 'Show them' })).toBeNull();
  });

  it('checking it lifts Needs review only, which would otherwise show nothing', async () => {
    mount('historical');
    await settle();
    openStatus();
    fireEvent.click(screen.getByLabelText('Previous format'));
    await settle();
    expect(screen.getByText('Needs review only').closest('button')?.getAttribute('aria-pressed')).toBe('false');
    expect(rowNodes()).toHaveLength(2);
  });

  it('"Previous format" alone shows only the old changes', async () => {
    mount('needs-review');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    openStatus();
    fireEvent.click(screen.getByLabelText('Previous format'));
    fireEvent.click(screen.getByLabelText('Unreviewed'));
    fireEvent.click(screen.getByLabelText('Reviewed'));
    await settle();
    expect(rowNodes()).toHaveLength(2);
  });

  it('a review state never filters them out: Reviewed + Previous format keeps both', async () => {
    mount('needs-review');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    openStatus();
    fireEvent.click(screen.getByLabelText('Unreviewed'));
    fireEvent.click(screen.getByLabelText('Previous format'));
    await settle();
    // One reviewed change (evt-reviewed) plus the two in the previous format.
    expect(rowNodes()).toHaveLength(3);
  });

  it('never enter Needs review, and are never written as reviewed', async () => {
    mount('needs-review');
    await settle();
    // Five need review with or without them: the two old ones carry nothing
    // a rule or heuristic raised.
    expect(cardTexts()[1]).toBe('5Needs review');
    openStatus();
    fireEvent.click(screen.getByLabelText('Previous format'));
    await settle();
    expect(cardTexts()[1]).toBe('5Needs review');
    const xcg = (window as unknown as { xcg: { setReviewStatus: ReturnType<typeof vi.fn> } }).xcg;
    expect(xcg.setReviewStatus).not.toHaveBeenCalled();
  });
});

describe('MCP changes — a change nothing flagged', () => {
  it('reads "None" and has no "Why this is flagged"', async () => {
    mount('all-changes');
    await settle();
    fireEvent.click(screen.getByText('Needs review only').closest('button')!);
    await settle();
    const stripe = rowNodes().find((r) => r.textContent?.includes('stripe'))!;
    expect(stripe.textContent).toContain('NONE');
    fireEvent.click(stripe);
    await settle();
    const panel = document.querySelector('[role="dialog"]')?.textContent ?? '';
    expect(panel).not.toContain('Why this is flagged');
    expect(panel).toContain('list_charges — Description changed');
    // The internal kind is still there for whoever opens Technical details.
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('description_changed:');
  });
});
