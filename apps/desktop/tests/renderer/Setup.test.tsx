// @vitest-environment jsdom
// Component tests for Setup: the re-login row glyph in the connectors list
// (Slice B) and the two empty-state variants (config present → three-step
// onboarding checklist; no config → value proposition + pointer). window.xcg
// is stubbed: listDetections drives the auth alerts; configIsConnected is
// queried by the (closed) AddConnectorModal mounted inside Setup. The glyph
// appears after the first poll resolves, so assertions use findBy*.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
function renderSetup(status: StatusResult = STATUS, onOpenSettings: () => void = noop): void {
  render(
    <Setup
      status={status}
      onRefresh={noop}
      onOpenInDetections={noop}
      onAudit={noop}
      onReconnect={vi.fn(async () => ({ ok: true, reconnected: true, name: 'notion' }))}
      onRemove={vi.fn(async () => ({ ok: true }))}
      onOpenSettings={onOpenSettings}
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

function emptyStatus(configPresent: boolean): StatusResult {
  return { ok: true, configPresent, entries: [] } as unknown as StatusResult;
}

describe('Setup — empty state (one checklist, step 1 adapts to configPresent)', () => {
  it('config present: step 1 wraps the existing config', () => {
    stubXcg([]);
    renderSetup(emptyStatus(true));
    expect(screen.getByText('Start auditing your connectors')).toBeDefined();
    expect(screen.getByText(/Route that traffic through xCLAUDE in three steps:/)).toBeDefined();
    expect(screen.getByText(/wraps the local MCP servers already in your Claude Desktop/)).toBeDefined();
    expect(screen.queryByText(/add at least one MCP server first/)).toBeNull();
    expect(screen.getByText('Add your connectors here')).toBeDefined();
    expect(screen.getByText(/the Set up button walks you through it/)).toBeDefined();
    expect(screen.getByText('Disconnect the native versions')).toBeDefined();
    expect(
      screen.getByText('Local MCP servers from your Claude config appear here after Install.'),
    ).toBeDefined();
  });

  it('no config: same checklist with the adapted step 1; old marketing state gone', () => {
    stubXcg([]);
    renderSetup(emptyStatus(false));
    expect(screen.getByText('Start auditing your connectors')).toBeDefined();
    expect(screen.getByText(/Route that traffic through xCLAUDE in three steps:/)).toBeDefined();
    expect(
      screen.getByText(/open Claude Desktop and add at least one MCP server first/),
    ).toBeDefined();
    expect(screen.queryByText(/wraps the local MCP servers already/)).toBeNull();
    expect(screen.getByText('Disconnect the native versions')).toBeDefined();
    expect(
      screen.getByText('Local MCP servers from your Claude config appear here after Install.'),
    ).toBeDefined();
    // The pre-1.0 no-config variant is gone entirely.
    expect(screen.queryByText('See what Claude does.')).toBeNull();
    expect(screen.queryByText(/Claude Desktop has no MCP config yet/)).toBeNull();
  });

  it('step 1 opens the Settings drawer; step 2 opens the Add connector modal', () => {
    stubXcg([]);
    const onOpenSettings = vi.fn();
    renderSetup(emptyStatus(true), onOpenSettings);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add your connectors here' }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('standalone "+ Add connector" CTA coexists with the step-2 link and opens the modal', () => {
    stubXcg([]);
    renderSetup(emptyStatus(true));
    // Both entry points render: the checklist's in-context link and the
    // screen's primary CTA below it.
    expect(screen.getByRole('button', { name: 'Add your connectors here' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '+ Add connector' }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});
