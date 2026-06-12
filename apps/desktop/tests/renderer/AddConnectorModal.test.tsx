// @vitest-environment jsdom
// DOM tests for the Add connector modal: visibility (open), search filtering
// (incl. hiding groups with no matches), the four button states, and the
// external "Request a connector" link. window.xcg is stubbed per test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AddConnectorModal } from '../../src/renderer/components/AddConnectorModal.js';

interface XcgStub {
  configIsConnected?: ReturnType<typeof vi.fn>;
  configConnect?: ReturnType<typeof vi.fn>;
  openExternalUrl?: ReturnType<typeof vi.fn>;
}

function stubXcg(overrides: XcgStub = {}): Required<XcgStub> {
  const api = {
    configIsConnected: vi.fn(async () => ({ ok: true, connected: false })),
    configConnect: vi.fn(async () => ({ ok: true, reconnected: false, name: 'x' })),
    openExternalUrl: vi.fn(async () => undefined),
    ...overrides,
  };
  vi.stubGlobal('xcg', api);
  return api;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderOpen(): void {
  render(<AddConnectorModal open onClose={vi.fn()} />);
}

describe('AddConnectorModal', () => {
  it('renders nothing when closed', () => {
    stubXcg();
    const { container } = render(<AddConnectorModal open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the gallery and groups when open', () => {
    stubXcg();
    renderOpen();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('One-click connect')).toBeDefined();
    expect(screen.getByText('Google services')).toBeDefined();
    // "Coming soon" appears twice (group label + asana button); assert the card.
    expect(screen.getByTestId('connector-card-asana')).toBeDefined();
    expect(screen.getByText('Notion')).toBeDefined();
  });

  it('filters cards by name and hides groups (and their notes) with no matches', () => {
    stubXcg();
    renderOpen();
    fireEvent.change(screen.getByLabelText('Search connectors'), { target: { value: 'git' } });
    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.queryByText('Notion')).toBeNull();
    expect(screen.queryByText('Gmail')).toBeNull();
    // Google group (its label + the one-time-setup note) is hidden entirely.
    expect(screen.queryByText('Google services')).toBeNull();
    expect(screen.queryByText(/One-time setup:/)).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('shows a no-match message when nothing matches', () => {
    stubXcg();
    renderOpen();
    fireEvent.change(screen.getByLabelText('Search connectors'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No connectors match/)).toBeDefined();
  });

  it('shows Connect for an unconnected entry', () => {
    stubXcg();
    renderOpen();
    const card = screen.getByTestId('connector-card-linear');
    expect(within(card).getByRole('button', { name: 'Connect' })).toBeDefined();
  });

  it('shows a disabled "Added" for an already-connected entry', async () => {
    stubXcg({
      configIsConnected: vi.fn(async (name: string) => ({ ok: true, connected: name === 'notion' })),
    });
    renderOpen();
    const notion = screen.getByTestId('connector-card-notion');
    const added = await within(notion).findByRole('button', { name: 'Added' });
    expect((added as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a disabled "Coming soon" for the asana entry', () => {
    stubXcg();
    renderOpen();
    const asana = screen.getByTestId('connector-card-asana');
    const btn = within(asana).getByRole('button', { name: 'Coming soon' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to "Connecting…" while a connect is in flight', async () => {
    // configConnect never resolves → the busy state persists.
    stubXcg({ configConnect: vi.fn(() => new Promise(() => {})) });
    renderOpen();
    const github = screen.getByTestId('connector-card-github');
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connecting… authorize in your browser')).toBeDefined();
  });

  it('opens the request link in the system browser (never navigates)', () => {
    const api = stubXcg();
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: /Request a connector/ }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://xclaude.ai');
  });
});
