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
      onReconnect={vi.fn(async () => ({ ok: true, reconnected: true, name: 'notion' }))}
      onRemove={vi.fn(async () => ({ ok: true }))}
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
