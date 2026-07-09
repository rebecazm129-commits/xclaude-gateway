// @vitest-environment jsdom
// F1-02: the residual-credentials notice. Component tests (render, exact copy,
// dismiss) plus unit tests of accumulateResidualCredentials — the App-side
// condition (only ok+wrote+tokensCleared:false accumulates, no duplicates).

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  ResidualCredentialsWarning,
  accumulateResidualCredentials,
} from '../../src/renderer/components/ResidualCredentialsWarning.js';
import type { RemoveRemoteResult } from '@xcg/shared/config';

afterEach(cleanup);

function wroteResult(name: string, tokensCleared?: boolean): RemoveRemoteResult {
  return {
    ok: true,
    op: 'remove-remote',
    configPath: '/tmp/config.json',
    name,
    outcome: 'wrote',
    ...(tokensCleared !== undefined ? { tokensCleared } : {}),
  };
}

describe('ResidualCredentialsWarning — render', () => {
  it('renders nothing with an empty list', () => {
    const { container } = render(<ResidualCredentialsWarning names={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('one connector: role status, title, exact body naming the three items', () => {
    render(<ResidualCredentialsWarning names={['gmail']} onDismiss={vi.fn()} />);
    const banner = screen.getByRole('status');
    expect(screen.getByText('Credentials may remain in your Keychain')).toBeTruthy();
    expect(banner.textContent).toContain(
      '"gmail" was removed, but clearing its stored credentials failed. ' +
        'One or more of these items may remain under the service com.xclaude.gateway: ' +
        'gmail:tokens, gmail:client, gmail:verifier. ' +
        'You can delete them manually in Keychain Access by searching for "com.xclaude.gateway".',
    );
  });

  it('two connectors: plural sentence and both item patterns', () => {
    render(<ResidualCredentialsWarning names={['gmail', 'drive']} onDismiss={vi.fn()} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain(
      '"gmail" and "drive" were removed, but clearing their stored credentials failed.',
    );
    expect(banner.textContent).toContain(
      'gmail:tokens, gmail:client, gmail:verifier; drive:tokens, drive:client, drive:verifier',
    );
  });

  it('dismiss button calls onDismiss and carries the explicit aria-label', () => {
    const onDismiss = vi.fn();
    render(<ResidualCredentialsWarning names={['gmail']} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Keychain credentials notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss makes the notice disappear (stateful harness, App wiring shape)', () => {
    function Harness(): JSX.Element {
      const [names, setNames] = useState<readonly string[]>(['gmail']);
      return <ResidualCredentialsWarning names={names} onDismiss={() => setNames([])} />;
    }
    render(<Harness />);
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Keychain credentials notice' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('accumulateResidualCredentials', () => {
  it('ok+wrote with tokensCleared:false → name added', () => {
    expect(accumulateResidualCredentials([], 'gmail', wroteResult('gmail', false))).toEqual([
      'gmail',
    ]);
  });

  it('tokensCleared:true → unchanged (same reference)', () => {
    const prev: readonly string[] = [];
    expect(accumulateResidualCredentials(prev, 'gmail', wroteResult('gmail', true))).toBe(prev);
  });

  it('tokensCleared absent (non-desktop producer) → unchanged', () => {
    const prev: readonly string[] = [];
    expect(accumulateResidualCredentials(prev, 'gmail', wroteResult('gmail'))).toBe(prev);
  });

  it('noop outcome → unchanged (Keychain untouched)', () => {
    const prev: readonly string[] = [];
    const noop: RemoveRemoteResult = {
      ok: true,
      op: 'remove-remote',
      configPath: '/tmp/config.json',
      name: 'gmail',
      outcome: 'noop',
    };
    expect(accumulateResidualCredentials(prev, 'gmail', noop)).toBe(prev);
  });

  it('failed remove → unchanged', () => {
    const prev: readonly string[] = [];
    const failed: RemoveRemoteResult = { ok: false, error: { kind: 'not-found' } };
    expect(accumulateResidualCredentials(prev, 'gmail', failed)).toBe(prev);
  });

  it('two different failed removes accumulate both; a repeat does not duplicate', () => {
    let names: readonly string[] = [];
    names = accumulateResidualCredentials(names, 'gmail', wroteResult('gmail', false));
    names = accumulateResidualCredentials(names, 'drive', wroteResult('drive', false));
    expect(names).toEqual(['gmail', 'drive']);
    const again = accumulateResidualCredentials(names, 'gmail', wroteResult('gmail', false));
    expect(again).toBe(names);
  });
});
