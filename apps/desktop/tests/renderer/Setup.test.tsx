// @vitest-environment jsdom
// Component test for the re-login row glyph in the connectors list (Slice B).
// window.xcg is stubbed: listDetections drives the auth alerts; configIsConnected
// is queried by the (closed) AddConnectorModal mounted inside Setup. The glyph
// appears after the first poll resolves, so assertions use findBy*.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Setup } from '../../src/renderer/components/Setup.js';
import type { StatusResult } from '@xcg/shared/config';

// One already-wrapped http entry → toConnectors yields { name:'notion',
// type:'remote', status:'audited' }, so the row renders in the Auditing group.
const STATUS = {
  ok: true,
  configPresent: true,
  entries: [
    {
      kind: 'skipped',
      reason: 'already-wrapped',
      transport: 'http',
      name: 'notion',
      endpoint: 'https://mcp.notion.com/mcp',
    },
  ],
} as unknown as StatusResult;

function stubXcg(authAlerts: ConnectorAuthAlertFixture[]): void {
  vi.stubGlobal('xcg', {
    listDetections: vi.fn(async () => ({ events: [], authAlerts })),
    configIsConnected: vi.fn(async () => ({ ok: true, connected: false })),
  });
}
interface ConnectorAuthAlertFixture {
  mcp: string;
  lastFailureTs: string;
  message: string;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = vi.fn();
function renderSetup(): void {
  render(
    <Setup
      status={STATUS}
      onRefresh={noop}
      onOpenInDetections={noop}
      onAudit={noop}
      onReconnect={vi.fn(async () => ({ ok: true, reconnected: true, name: 'notion' }))}
      onRemove={vi.fn(async () => ({ ok: true }))}
    />,
  );
}

describe('Setup — re-login row glyph', () => {
  it('shows the warning glyph on a connector that needs re-login', async () => {
    stubXcg([{ mcp: 'notion', lastFailureTs: '2026-06-16T10:00:00.000Z', message: 'x' }]);
    renderSetup();
    expect(await screen.findByLabelText('needs re-login')).toBeDefined();
  });

  it('no glyph when there are no alerts', async () => {
    stubXcg([]);
    renderSetup();
    // Row is rendered (sync, from status); the glyph would only appear via alerts.
    expect(await screen.findByText('notion')).toBeDefined();
    expect(screen.queryByLabelText('needs re-login')).toBeNull();
  });
});
