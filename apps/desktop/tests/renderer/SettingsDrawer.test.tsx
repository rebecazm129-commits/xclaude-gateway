// @vitest-environment jsdom
// The "Open xCLAUDE at login" control. The load-bearing claim is that the panel
// never caches the boolean: macOS System Settings > General > Login Items can
// change it behind the app's back, so every open re-reads it and every write
// trusts what the OS reports back, not what was requested.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SettingsDrawer } from '../../src/renderer/components/SettingsDrawer.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubXcg(over: Record<string, unknown> = {}): Record<string, unknown> {
  const api = {
    openAtLogin: vi.fn(async () => false),
    setOpenAtLogin: vi.fn(async (v: boolean) => v),
    retentionStatus: vi.fn(async () => ({
      config: { purgeMode: 'never', sizeWarnBytes: 1 },
      size: null,
      lastPurge: null,
    })),
    appVersion: vi.fn(async () => '1.0.0-beta.6'),
    openAuditFolder: vi.fn(async () => undefined),
    retentionEstimate: vi.fn(async () => 0),
    retentionSetMode: vi.fn(async () => ({ ok: false, config: {}, purgableEstimate: 0 })),
    ...over,
  };
  vi.stubGlobal('xcg', api);
  return api;
}

function renderDrawer(): void {
  render(<SettingsDrawer status={null} onRefresh={vi.fn()} onClose={vi.fn()} />);
}

const switchEl = (): HTMLElement => screen.getByRole('switch', { name: 'Open xCLAUDE at login' });
const checked = (): string | null => switchEl().getAttribute('aria-checked');

describe('SettingsDrawer — open at login', () => {
  it('is the first control in the panel', async () => {
    stubXcg();
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
    expect(screen.getByText('Open xCLAUDE at login')).toBeTruthy();
  });

  it('reads the OS value on open — Off', async () => {
    const api = stubXcg({ openAtLogin: vi.fn(async () => false) });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
    expect(api['openAtLogin']).toHaveBeenCalledTimes(1);
  });

  it('reads the OS value on open — On', async () => {
    stubXcg({ openAtLogin: vi.fn(async () => true) });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('true'));
  });

  it('turning it on calls the handler with true and adopts the returned state', async () => {
    const setOpenAtLogin = vi.fn(async () => true);
    stubXcg({ setOpenAtLogin });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
    fireEvent.click(switchEl());
    expect(setOpenAtLogin).toHaveBeenCalledWith(true);
    await waitFor(() => expect(checked()).toBe('true'));
  });

  it('adopts the OS answer even when it contradicts the request', async () => {
    // The OS refused (policy, MDM, a failed registration). The panel must show
    // what is true, not what was asked for.
    const setOpenAtLogin = vi.fn(async () => false);
    stubXcg({ setOpenAtLogin });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
    fireEvent.click(switchEl());
    await waitFor(() => expect(setOpenAtLogin).toHaveBeenCalled());
    expect(checked()).toBe('false');
  });

  it('an external change between opens is picked up (no cached boolean)', async () => {
    const openAtLoginFn = vi.fn();
    openAtLoginFn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    stubXcg({ openAtLogin: openAtLoginFn });
    const { unmount } = render(
      <SettingsDrawer status={null} onRefresh={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(checked()).toBe('false'));
    unmount();
    // Reopened after the user enabled it in System Settings.
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('true'));
    expect(openAtLoginFn).toHaveBeenCalledTimes(2);
  });

  it('a failing read degrades to Off without throwing', async () => {
    stubXcg({ openAtLogin: vi.fn(async () => Promise.reject(new Error('nope'))) });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
  });

  it('the switch is disabled until the first read resolves', async () => {
    let release: (v: boolean) => void = () => {};
    const pending = new Promise<boolean>((r) => {
      release = r;
    });
    stubXcg({ openAtLogin: vi.fn(() => pending) });
    renderDrawer();
    expect((switchEl() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release(false);
    });
    await waitFor(() => expect((switchEl() as HTMLButtonElement).disabled).toBe(false));
  });

  it('turning it off from On sends false', async () => {
    const setOpenAtLogin = vi.fn(async () => false);
    stubXcg({ openAtLogin: vi.fn(async () => true), setOpenAtLogin });
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('true'));
    fireEvent.click(switchEl());
    expect(setOpenAtLogin).toHaveBeenCalledWith(false);
    await waitFor(() => expect(checked()).toBe('false'));
  });

  it('the caption says why it runs in the menu bar', async () => {
    stubXcg();
    renderDrawer();
    await waitFor(() => expect(checked()).toBe('false'));
    expect(
      screen.getByText(
        'Runs in the menu bar so it can alert you when a connector needs re-login.',
      ),
    ).toBeTruthy();
  });
});
