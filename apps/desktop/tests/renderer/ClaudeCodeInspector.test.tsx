// @vitest-environment jsdom
// Component tests for ClaudeCodeInspector (F1.3c): kv rows, the Auditing
// active chip, the Open in Detections callback and the relative heartbeat.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ClaudeCodeInspector, formatRelative } from '../../src/renderer/components/ClaudeCodeInspector.js';
import type { CchookStatus } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STATUS: CchookStatus = {
  installed: true,
  hookRegistered: true,
  pendingSpool: 3,
  unreadableTotal: 1,
  lastCycle: { processed: 5, skippedUnreadable: 1, deletedStale: 0, ts: '2026-07-16T09:00:00.000Z' },
  lastSessionStartTs: new Date(Date.now() - 5 * 60_000).toISOString(),
};

describe('ClaudeCodeInspector', () => {
  it('renders the kv rows, the active chip and the scope note', () => {
    render(<ClaudeCodeInspector status={STATUS} flagged7d={2} onOpenInDetections={() => {}} />);
    expect(screen.getByText('claude-code')).toBeDefined();
    expect(screen.getByText('Auditing active')).toBeDefined();
    expect(screen.getByText('registered · ~/.claude/settings.json')).toBeDefined();
    expect(screen.getByText('5m ago')).toBeDefined();
    expect(screen.getByText('3 / 1')).toBeDefined(); // pending / unreadable
    expect(screen.getByText('2')).toBeDefined(); // flagged 7d
    expect(screen.getByText(/doesn't see raw MCP wire · no manifest monitoring/)).toBeDefined();
  });

  it('null status → em-dash placeholders, no chip', () => {
    render(<ClaudeCodeInspector status={null} flagged7d={0} onOpenInDetections={() => {}} />);
    expect(screen.queryByText('Auditing active')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('Open in Detections fires the callback', () => {
    const onOpen = vi.fn();
    render(<ClaudeCodeInspector status={STATUS} flagged7d={0} onOpenInDetections={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Detections' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeInspector — Uninstall hook (F1.3d)', () => {
  it('two-step confirmation: Uninstall hook → Confirm/Cancel; confirm calls cchookUninstall', async () => {
    const cchookUninstall = vi.fn(async () => ({ ok: true, outcome: 'wrote', settingsPath: '/tmp/s.json' }));
    vi.stubGlobal('xcg', { cchookUninstall });
    render(<ClaudeCodeInspector status={STATUS} flagged7d={0} onOpenInDetections={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    expect(cchookUninstall).not.toHaveBeenCalled(); // first click only arms the confirm
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }));
    await waitFor(() => expect(cchookUninstall).toHaveBeenCalledTimes(1));
  });

  it('Cancel disarms without calling; error result surfaces as a banner', async () => {
    const cchookUninstall = vi.fn(async () => ({ ok: false, error: 'settings.json is not valid JSON' }));
    vi.stubGlobal('xcg', { cchookUninstall });
    render(<ClaudeCodeInspector status={STATUS} flagged7d={0} onOpenInDetections={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cchookUninstall).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Uninstall hook' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall hook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }));
    await waitFor(() => {
      expect(screen.getByText('settings.json is not valid JSON')).toBeDefined();
    });
  });

  it('no Uninstall button when the hook is not registered', () => {
    render(
      <ClaudeCodeInspector
        status={{ ...STATUS, hookRegistered: false }}
        flagged7d={0}
        onOpenInDetections={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Uninstall hook' })).toBeNull();
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-07-16T12:00:00.000Z');
  it('coarse buckets', () => {
    expect(formatRelative('2026-07-16T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelative('2026-07-16T11:15:00.000Z', now)).toBe('45m ago');
    expect(formatRelative('2026-07-16T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-07-14T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelative('garbage', now)).toBe('—');
  });
});
