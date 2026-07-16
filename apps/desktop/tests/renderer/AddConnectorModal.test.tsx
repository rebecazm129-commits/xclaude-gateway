// @vitest-environment jsdom
// DOM tests for the Add connector modal: visibility (open), search filtering
// (incl. hiding groups with no matches), the four button states, the external
// "Request a connector" link, and the Google BYO setup wizard (steps, deep
// links, credentials validation and seeding). window.xcg is stubbed per test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AddConnectorModal } from '../../src/renderer/components/AddConnectorModal.js';

interface XcgStub {
  configIsConnected?: ReturnType<typeof vi.fn>;
  configConnect?: ReturnType<typeof vi.fn>;
  openExternalUrl?: ReturnType<typeof vi.fn>;
  configHasClient?: ReturnType<typeof vi.fn>;
  configSeedClient?: ReturnType<typeof vi.fn>;
  cchookStatus?: ReturnType<typeof vi.fn>;
  cchookInstall?: ReturnType<typeof vi.fn>;
}

const CCHOOK_NOT_INSTALLED = {
  installed: false,
  hookRegistered: false,
  pendingSpool: 0,
  unreadableTotal: 0,
  lastCycle: null,
  lastSessionStartTs: null,
};

function stubXcg(overrides: XcgStub = {}): Required<XcgStub> {
  const api = {
    configIsConnected: vi.fn(async () => ({ ok: true, connected: false })),
    configConnect: vi.fn(async () => ({ ok: true, reconnected: false, name: 'x' })),
    openExternalUrl: vi.fn(async () => undefined),
    configHasClient: vi.fn(async () => false),
    configSeedClient: vi.fn(async () => ({ ok: true, seeded: [], warnings: [] })),
    cchookStatus: vi.fn(async () => CCHOOK_NOT_INSTALLED),
    cchookInstall: vi.fn(async () => ({ ok: true, outcome: 'wrote', settingsPath: '/tmp/s.json' })),
    ...overrides,
  };
  vi.stubGlobal('xcg', api);
  return api;
}

afterEach(async () => {
  cleanup();
  // The modal's async check() loops keep awaiting window.xcg calls after the
  // unmount (their `cancelled` flag only suppresses the final setState, not the
  // loop). Drain them while the stub is still in place: otherwise the tail of
  // the loop hits the removed global and the F2-01 logging spams TypeErrors
  // across the suite. One macrotask flushes the whole microtask chain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

function renderOpen(): void {
  render(<AddConnectorModal open onClose={vi.fn()} />);
}

describe('AddConnectorModal — Claude Code app card (F1.3d)', () => {
  const card = (): HTMLElement => screen.getByTestId('connector-card-claude-code');

  it('not installed on this Mac → disabled "Not detected" button, micro-note visible', async () => {
    stubXcg(); // default cchookStatus: installed false
    renderOpen();
    expect(screen.getByText('Audit sources')).toBeDefined(); // group label
    const btn = await within(card()).findByRole('button', { name: 'Not detected on this Mac' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(within(card()).getByText(/Adds an observation hook to ~\/.claude\/settings.json/)).toBeDefined();
  });

  it('hook already registered → Added', async () => {
    stubXcg({
      cchookStatus: vi.fn(async () => ({ ...CCHOOK_NOT_INSTALLED, installed: true, hookRegistered: true })),
    });
    renderOpen();
    const btn = await within(card()).findByRole('button', { name: 'Added' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('installed without hook → Install hook; happy click installs and lands on Added', async () => {
    const cchookStatus = vi
      .fn()
      .mockResolvedValueOnce({ ...CCHOOK_NOT_INSTALLED, installed: true }) // [open] check
      .mockResolvedValue({ ...CCHOOK_NOT_INSTALLED, installed: true, hookRegistered: true }); // post-install
    const api = stubXcg({ cchookStatus });
    renderOpen();
    const btn = await within(card()).findByRole('button', { name: 'Install hook' });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(within(card()).getByRole('button', { name: 'Added' })).toBeDefined();
    });
    expect(api.cchookInstall).toHaveBeenCalledTimes(1);
  });

  it('the former modal subtitle now lives as the one-click group note', () => {
    stubXcg();
    renderOpen();
    expect(screen.getByText(/Connect a remote service through xCLAUDE/)).toBeDefined();
  });
});

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
    fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'git' } });
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
    fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No sources match/)).toBeDefined();
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

  it('re-checks connected state on reopen: an out-of-band remove returns the card to Connect / Set up…', async () => {
    const api = stubXcg({
      configIsConnected: vi.fn(async (name: string) => ({
        ok: true,
        connected: name === 'notion' || name === 'gmail',
      })),
    });
    const { rerender } = render(<AddConnectorModal open onClose={vi.fn()} />);
    await within(screen.getByTestId('connector-card-notion')).findByRole('button', { name: 'Added' });
    await within(screen.getByTestId('connector-card-gmail')).findByRole('button', { name: 'Added' });

    // Close the modal (it stays mounted) and remove both connectors out of band
    // — e.g. Remove in the inspector, which also clears gmail's seeded client.
    rerender(<AddConnectorModal open={false} onClose={vi.fn()} />);
    api.configIsConnected.mockImplementation(async () => ({ ok: true, connected: false }));

    rerender(<AddConnectorModal open onClose={vi.fn()} />);
    await within(screen.getByTestId('connector-card-notion')).findByRole('button', { name: 'Connect' });
    // gmail is BYO and its client is gone too (configHasClient stays false) → back to setup.
    await within(screen.getByTestId('connector-card-gmail')).findByRole('button', { name: 'Set up…' });
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

  it('a stale connect error does not reappear on reopen (F1-03)', async () => {
    stubXcg({
      configConnect: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { rerender } = render(<AddConnectorModal open onClose={vi.fn()} />);
    const github = screen.getByTestId('connector-card-github');
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connection failed: boom')).toBeTruthy();

    rerender(<AddConnectorModal open={false} onClose={vi.fn()} />);
    rerender(<AddConnectorModal open onClose={vi.fn()} />);
    expect(screen.queryByText(/Connection failed/)).toBeNull();
  });

  it('"Set up…" is disabled while a connect is in flight (F1-04)', async () => {
    // configConnect never resolves → busyName stays set.
    stubXcg({ configConnect: vi.fn(() => new Promise(() => {})) });
    renderOpen();
    const github = screen.getByTestId('connector-card-github');
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    await screen.findByText('Connecting… authorize in your browser');
    const gmail = screen.getByTestId('connector-card-gmail');
    const setup = within(gmail).getByRole('button', { name: 'Set up…' }) as HTMLButtonElement;
    expect(setup.disabled).toBe(true);
  });

  it('opens the request link in the system browser (never navigates)', () => {
    const api = stubXcg();
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: /Request a connector/ }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://xclaude.ai/contact');
  });

  it('Google with a seeded client shows "Connect"', async () => {
    stubXcg({ configHasClient: vi.fn(async (name: string) => name === 'gmail') });
    renderOpen();
    const gmail = screen.getByTestId('connector-card-gmail');
    expect(await within(gmail).findByRole('button', { name: 'Connect' })).toBeDefined();
  });
});

// "Set up…" on an unseeded Google card opens the wizard in place of the gallery.
async function openWizard(): Promise<void> {
  const gmail = screen.getByTestId('connector-card-gmail');
  fireEvent.click(await within(gmail).findByRole('button', { name: 'Set up…' }));
}

// Intro → Step 4/4 (credentials). Advance labels are part of the contract:
// steps 1-2 confirm work done in the console ("Done — next"); step 3's
// enrollment completes out of band, so it's a plain "Next".
function walkToCredentials(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

describe('ConnectorSetupWizard (via AddConnectorModal)', () => {
  it('opens on the intro: title, domain warning and the derived steps line', async () => {
    stubXcg(); // configHasClient defaults to false → not seeded
    renderOpen();
    await openWizard();
    expect(screen.getByText('Set up Google connectors')).toBeDefined();
    expect(screen.getByText(/email on a custom domain/)).toBeDefined();
    expect(
      screen.getByText(/4 steps: Cloud project → OAuth client → Preview enrollment → paste your credentials/),
    ).toBeDefined();
    // The gallery is replaced while the wizard is open.
    expect(screen.queryByTestId('connector-card-notion')).toBeNull();
  });

  it('walks the four steps with the right counters and advance labels', async () => {
    stubXcg();
    renderOpen();
    await openWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));
    expect(screen.getByText('Step 1/4')).toBeDefined();
    expect(screen.getByRole('button', { name: /Enable all required APIs/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
    expect(screen.getByText('Step 2/4')).toBeDefined();
    expect(screen.getByText(/Desktop app/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
    expect(screen.getByText('Step 3/4')).toBeDefined();
    // Enrollment is async → plain "Next", never "Done — next".
    expect(screen.queryByRole('button', { name: 'Done — next' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 4/4')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save and finish' })).toBeDefined();
  });

  it('deep links: bulk enable carries all six API ids; step 3 links the program page', async () => {
    const api = stubXcg();
    renderOpen();
    await openWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));
    fireEvent.click(screen.getByRole('button', { name: /Enable all required APIs/ }));
    expect(api.openExternalUrl).toHaveBeenCalledWith(
      'https://console.cloud.google.com/flows/enableapi?apiid=' +
        'gmail.googleapis.com,drive.googleapis.com,calendar-json.googleapis.com,' +
        'gmailmcp.googleapis.com,drivemcp.googleapis.com,calendarmcp.googleapis.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
    fireEvent.click(screen.getByRole('button', { name: /Open the enrollment page/ }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://developers.google.com/workspace/preview');
  });

  it('empty client secret blocks the save with a UI error — seed is never called', async () => {
    const api = stubXcg();
    renderOpen();
    await openWizard();
    walkToCredentials();
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid.apps.googleusercontent.com' },
    });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and finish' }));
    expect(screen.getByText('Google requires a client secret.')).toBeDefined();
    expect(api.configSeedClient).not.toHaveBeenCalled();
  });

  it('successful save seeds the three targets, shows the banner, and unlocks Connect', async () => {
    const api = stubXcg({
      configSeedClient: vi.fn(async () => ({
        ok: true,
        seeded: ['gmail', 'calendar', 'drive'],
        warnings: [],
      })),
    });
    renderOpen();
    await openWizard();
    walkToCredentials();
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid.apps.googleusercontent.com' },
    });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'GOCSPX-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and finish' }));
    expect(
      await screen.findByText('Saved to Keychain — Gmail, Calendar and Drive are ready to connect.'),
    ).toBeDefined();
    expect(api.configSeedClient).toHaveBeenCalledWith(
      ['gmail', 'calendar', 'drive'],
      'cid.apps.googleusercontent.com',
      'GOCSPX-x',
    );
    // Back in the gallery, the seeded Google cards now offer Connect.
    fireEvent.click(screen.getByRole('button', { name: 'Back to connectors' }));
    const gmail = screen.getByTestId('connector-card-gmail');
    expect(within(gmail).getByRole('button', { name: 'Connect' })).toBeDefined();
  });

  it('failed save shows a red banner and keeps the pasted values for retry', async () => {
    stubXcg({
      configSeedClient: vi.fn(async () => ({
        ok: false,
        error: 'keychain write failed for "gmail:client" (code 51)',
      })),
    });
    renderOpen();
    await openWizard();
    walkToCredentials();
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid.apps.googleusercontent.com' },
    });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'GOCSPX-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and finish' }));
    expect(await screen.findByText(/keychain write failed/)).toBeDefined();
    expect((screen.getByLabelText('Client ID') as HTMLInputElement).value).toBe(
      'cid.apps.googleusercontent.com',
    );
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('GOCSPX-x');
    expect(screen.getByRole('button', { name: 'Save and finish' })).toBeDefined();
  });
});

// "Set up…" on the unseeded Slack card (routing via entry.setupCatalog).
async function openSlackWizard(): Promise<void> {
  const slack = screen.getByTestId('connector-card-slack');
  fireEvent.click(await within(slack).findByRole('button', { name: 'Set up…' }));
}

describe('ConnectorSetupWizard — Slack catalog', () => {
  it('Slack group note renders and unseeded Slack routes to the Slack intro', async () => {
    stubXcg(); // configHasClient defaults to false → not seeded
    renderOpen();
    expect(screen.getByText(/Slack needs a one-time app setup/)).toBeDefined();
    await openSlackWizard();
    expect(screen.getByText('Set up Slack')).toBeDefined();
    // Step count and route map derived from the slack catalog (1 step + credentials).
    expect(screen.getByText(/2 steps: Slack app → paste your Client ID/)).toBeDefined();
  });

  it('Slack with a seeded client shows "Connect" (seeding check follows setupCatalog)', async () => {
    stubXcg({ configHasClient: vi.fn(async (name: string) => name === 'slack') });
    renderOpen();
    const slack = screen.getByTestId('connector-card-slack');
    expect(await within(slack).findByRole('button', { name: 'Connect' })).toBeDefined();
  });

  it('step 1 deep-links the manifest-preloaded app creation URL', async () => {
    const api = stubXcg();
    renderOpen();
    await openSlackWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));
    expect(screen.getByText('Step 1/2')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Create the Slack app/ }));
    const url = api.openExternalUrl.mock.calls[0]?.[0] as string;
    expect(url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
    // The encoded manifest carries the product redirect URI and the PKCE flag.
    const manifest = JSON.parse(
      decodeURIComponent(url.split('manifest_json=')[1] ?? ''),
    ) as { oauth_config: { redirect_urls: string[]; pkce_enabled: boolean } };
    expect(manifest.oauth_config.redirect_urls).toEqual(['http://127.0.0.1:51703/xcg-callback']);
    expect(manifest.oauth_config.pkce_enabled).toBe(true);
  });

  it('credentials: single Client ID field with hint, no secret field, seeds ["slack"]', async () => {
    const api = stubXcg({
      configSeedClient: vi.fn(async () => ({ ok: true, seeded: ['slack'], warnings: [] })),
    });
    renderOpen();
    await openSlackWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done — next' }));
    expect(screen.getByText('Step 2/2')).toBeDefined();
    // secretRequired: false → the secret field is not rendered at all.
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect(screen.getByText(/Basic Information → App Credentials → Client ID/)).toBeDefined();
    // The hint is part of the label's accessible name → match by prefix.
    fireEvent.change(screen.getByLabelText(/^Client ID/), { target: { value: '1111.2222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and finish' }));
    expect(
      await screen.findByText('Saved to Keychain — Slack is ready to connect.'),
    ).toBeDefined();
    expect(api.configSeedClient).toHaveBeenCalledWith(['slack'], '1111.2222', undefined);
    // Back in the gallery, Slack now offers Connect.
    fireEvent.click(screen.getByRole('button', { name: 'Back to connectors' }));
    const slack = screen.getByTestId('connector-card-slack');
    expect(within(slack).getByRole('button', { name: 'Connect' })).toBeDefined();
  });
});
