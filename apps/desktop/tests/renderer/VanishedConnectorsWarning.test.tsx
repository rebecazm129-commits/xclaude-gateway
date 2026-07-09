// @vitest-environment jsdom
// F2-04 step 2: managed connectors that vanished from the config out-of-band.
// Unit tests of the diff/accumulate/prune helpers (App's detection pipeline)
// plus component tests (copy, Re-add without dismiss, explicit dismiss).

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  VanishedConnectorsWarning,
  appendUniqueNames,
  diffVanishedConnectors,
  pruneAgedRemoves,
} from '../../src/renderer/components/VanishedConnectorsWarning.js';
import type { StatusResult } from '@xcg/shared/config';

afterEach(cleanup);

// Snapshot with the given already-wrapped http (remote) names plus one local
// wrappable entry, so the remote-only filter has something to ignore.
function snap(remoteNames: readonly string[]): StatusResult {
  return {
    ok: true,
    configPresent: true,
    configPath: '/tmp/claude_desktop_config.json',
    entries: [
      ...remoteNames.map((name) => ({
        kind: 'skipped' as const,
        reason: 'already-wrapped' as const,
        transport: 'http' as const,
        name,
        endpoint: `https://mcp.example.com/${name}`,
      })),
      { kind: 'wrappable' as const, name: 'local-fs', transport: 'stdio' as const },
    ],
    summary: { wrappable: 1, alreadyWrapped: remoteNames.length, skippedOther: 0 },
  } as unknown as StatusResult;
}

const NONE: ReadonlySet<string> = new Set();

describe('diffVanishedConnectors', () => {
  it('remote connector in previous, absent in current → reported', () => {
    expect(diffVanishedConnectors(snap(['notion', 'stripe']), snap(['stripe']), NONE)).toEqual([
      'notion',
    ]);
  });

  it('local entries never count as vanished (managed = remote only)', () => {
    // previous has local-fs (in every snap); current lacks it entirely.
    const current = { ...snap(['notion']), entries: snap(['notion']).entries.slice(0, 1) };
    expect(diffVanishedConnectors(snap(['notion']), current as StatusResult, NONE)).toEqual([]);
  });

  // Covers the remove→tick race too: the poll can land between main writing
  // the config and the remove promise resolving, but handleRemove registers
  // the name BEFORE the IPC call, so the exclusion set already contains it
  // whenever this diff runs.
  it('in-app remove is excluded from the diff', () => {
    expect(
      diffVanishedConnectors(snap(['notion', 'stripe']), snap(['stripe']), new Set(['notion'])),
    ).toEqual([]);
  });

  it('reconnect never fires: the entry exists in both snapshots (replaceRemoteInConfig overwrites in one atomic write)', () => {
    expect(diffVanishedConnectors(snap(['notion']), snap(['notion']), NONE)).toEqual([]);
  });

  it('null or error snapshots → empty diff', () => {
    expect(diffVanishedConnectors(null, snap(['a']), NONE)).toEqual([]);
    expect(diffVanishedConnectors(snap(['a']), null, NONE)).toEqual([]);
    const err = { ok: false, error: { kind: 'invalid-json', detail: 'x' } } as StatusResult;
    expect(diffVanishedConnectors(err, snap([]), NONE)).toEqual([]);
    expect(diffVanishedConnectors(snap(['a']), err, NONE)).toEqual([]);
  });
});

describe('appendUniqueNames', () => {
  it('accumulates without duplicates; unchanged input keeps the same reference', () => {
    const first = appendUniqueNames([], ['notion']);
    expect(first).toEqual(['notion']);
    const second = appendUniqueNames(first, ['stripe', 'notion']);
    expect(second).toEqual(['notion', 'stripe']);
    expect(appendUniqueNames(second, ['notion'])).toBe(second);
  });
});

describe('pruneAgedRemoves', () => {
  it('drops a name once it has left the previous snapshot; keeps it while present', () => {
    const removes = new Set(['notion', 'stripe']);
    // notion still in previous (remove not yet aged), stripe already gone.
    pruneAgedRemoves(removes, snap(['notion']));
    expect([...removes]).toEqual(['notion']);
  });
});

describe('VanishedConnectorsWarning — render', () => {
  it('renders nothing with an empty list', () => {
    const { container } = render(
      <VanishedConnectorsWarning names={[]} onReAdd={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('plural copy exactly as specified', () => {
    render(
      <VanishedConnectorsWarning names={['notion', 'stripe']} onReAdd={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText('Connectors removed outside xCLAUDE')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      '"notion" and "stripe" were removed from your Claude Desktop config by another program ' +
        'and are no longer audited.',
    );
  });

  it('singular copy adapts verb and pronoun', () => {
    render(<VanishedConnectorsWarning names={['notion']} onReAdd={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain(
      '"notion" was removed from your Claude Desktop config by another program and is no longer audited.',
    );
  });

  it('"Re-add connectors" invokes onReAdd and does NOT dismiss', () => {
    const onReAdd = vi.fn();
    function Harness(): JSX.Element {
      const [names, setNames] = useState<readonly string[]>(['notion']);
      return (
        <VanishedConnectorsWarning names={names} onReAdd={onReAdd} onDismiss={() => setNames([])} />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-add connectors' }));
    expect(onReAdd).toHaveBeenCalledTimes(1);
    // Still visible: re-add is not a dismiss.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('Dismiss clears the notice (explicit aria-label)', () => {
    function Harness(): JSX.Element {
      const [names, setNames] = useState<readonly string[]>(['notion', 'stripe']);
      return (
        <VanishedConnectorsWarning names={names} onReAdd={vi.fn()} onDismiss={() => setNames([])} />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss removed-connectors notice' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
