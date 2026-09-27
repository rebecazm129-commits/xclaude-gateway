// @vitest-environment jsdom
// Component tests for the re-login alert surfaces in the connector inspector
// (Slice B): header status, the "Authorization expired" strip, and the
// highlighted Reconnect. window.xcg is stubbed per test. CSS modules are not
// processed under vitest, so the highlight is asserted by className token count
// (base vs base+primary), not by the hashed class name.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ConnectorInspector } from '../../src/renderer/components/ConnectorInspector.js';
import type { Connector } from '@xcg/shared/config/connectors';
import type { ConnectResult, RemoveRemoteResult } from '@xcg/shared/config';
import type { ConnectorAuthAlert } from '../../src/shared/types.js';

function stubXcg(): void {
  vi.stubGlobal('xcg', {
    listDetections: vi.fn(async () => ({ events: [], authAlerts: [] })),
    configHasCredentials: vi.fn(async () => true),
    configToolCount: vi.fn(async () => null),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONNECTOR: Connector = {
  name: 'notion',
  type: 'remote',
  status: 'audited',
  endpoint: 'https://mcp.notion.com/mcp',
};
const ALERT: ConnectorAuthAlert = {
  mcp: 'notion',
  lastFailureTs: '2026-06-16T10:00:00.000Z',
  message: 'reauth required',
};

const noop = vi.fn();
function renderInspector(authAlert: ConnectorAuthAlert | null): void {
  render(
    <ConnectorInspector
      connector={CONNECTOR}
      authAlert={authAlert}
      onOpenInDetections={noop}
      onAudit={noop}
      // Complete ConnectOk/RemoveRemoteOk shapes (these tests never click
      // Reconnect/Remove, so the results are wiring, not data under test).
      onReconnect={vi.fn(
        async (): Promise<ConnectResult> => ({
          ok: true,
          op: 'connect',
          configPath: '/tmp/claude_desktop_config.json',
          name: 'notion',
          outcome: 'wrote',
          reconnected: true,
        }),
      )}
      onRemove={vi.fn(
        async (): Promise<RemoveRemoteResult> => ({
          ok: true,
          op: 'remove-remote',
          configPath: '/tmp/claude_desktop_config.json',
          name: 'notion',
          outcome: 'wrote',
        }),
      )}
    />,
  );
}

const tokenCount = (el: Element): number => el.className.split(/\s+/).filter(Boolean).length;

describe('ConnectorInspector — re-login alert', () => {
  it('alerted: "Needs re-login" header, "Authorization expired" strip, highlighted Reconnect', () => {
    stubXcg();
    renderInspector(ALERT);
    expect(screen.getByText('Needs re-login')).toBeDefined();
    expect(screen.getByText('Authorization expired')).toBeDefined();
    expect(
      screen.getByText('Reconnect to resume auditing, then restart Claude Desktop.'),
    ).toBeDefined();
    // base class + primary variant → two className tokens.
    expect(tokenCount(screen.getByRole('button', { name: 'Reconnect' }))).toBe(2);
  });

  it('not alerted: normal status, no strip, Reconnect not highlighted', () => {
    stubXcg();
    renderInspector(null);
    expect(screen.getByText('Auditing')).toBeDefined();
    expect(screen.queryByText('Authorization expired')).toBeNull();
    expect(screen.queryByText('Needs re-login')).toBeNull();
    // base class only → fewer tokens than the highlighted variant.
    expect(tokenCount(screen.getByRole('button', { name: 'Reconnect' }))).toBeLessThan(2);
  });
});

describe('ConnectorInspector — version source', () => {
  function renderConnector(connector: Connector): void {
    render(
      <ConnectorInspector
        connector={connector}
        authAlert={null}
        onOpenInDetections={noop}
        onAudit={noop}
        onReconnect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
  }
  const local = (launch?: Connector['launch']): Connector => ({
    name: 'filesystem',
    type: 'local',
    status: 'audited',
    endpoint: 'npx',
    ...(launch !== undefined ? { launch } : {}),
  });

  it('mutable npx: "Mutable" plus the version note, no package name', () => {
    stubXcg();
    renderConnector(local({
      launcher: 'npx',
      package: '@modelcontextprotocol/server-filesystem',
      spec: '@modelcontextprotocol/server-filesystem',
      mutable: true,
    }));
    const row = screen.getByTestId('launch-reference');
    expect(row.textContent).toContain('Version source');
    expect(row.textContent).toContain('Mutable');
    expect(screen.getByText(
      'This reference can resolve to a different version on a future launch. Pin a version for reproducible launches.',
    )).toBeDefined();
    expect(row.textContent).not.toContain('@modelcontextprotocol/server-filesystem');
  });

  it('mutable docker: the image note', () => {
    stubXcg();
    renderConnector(local({
      launcher: 'docker',
      package: 'ghcr.io/github/github-mcp-server',
      spec: 'ghcr.io/github/github-mcp-server',
      mutable: true,
    }));
    expect(screen.getByText(
      'This tag can point to a different image over time. Pin a digest for reproducible launches.',
    )).toBeDefined();
    expect(screen.getByTestId('launch-reference').textContent).not.toContain('ghcr.io');
  });

  it('pinned: "Pinned to" the version or short digest, no note', () => {
    stubXcg();
    renderConnector(local({ launcher: 'npx', package: '@playwright/mcp', spec: '@playwright/mcp@0.0.41', mutable: false, pinned: '0.0.41' }));
    const row = screen.getByTestId('launch-reference');
    expect(row.querySelector('dd')?.textContent).toBe('Pinned to 0.0.41');
    expect(row.querySelector('p')).toBeNull();
    cleanup();
    renderConnector(local({ launcher: 'docker', package: 'mcp/fetch', spec: 'mcp/fetch@sha256:…', mutable: false, pinned: 'sha256:aaaaaaaaaaaa' }));
    expect(screen.getByTestId('launch-reference').querySelector('dd')?.textContent).toBe('Pinned to sha256:aaaaaaaaaaaa');
  });

  it('no launch reference (remote, other launchers): no row', () => {
    stubXcg();
    renderConnector(CONNECTOR);
    expect(screen.queryByTestId('launch-reference')).toBeNull();
    cleanup();
    renderConnector(local());
    expect(screen.queryByText('Version source')).toBeNull();
  });

  it('no alert icon in the row', () => {
    stubXcg();
    renderConnector(local({ launcher: 'npx', package: 'p', spec: 'p', mutable: true }));
    expect(screen.getByTestId('launch-reference').textContent).not.toContain('⚠');
  });
});

