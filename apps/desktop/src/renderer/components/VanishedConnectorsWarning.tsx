import type { ReactElement } from 'react';

import { toConnectors } from '@xcg/shared/config/connectors';
import type { StatusResult } from '@xcg/shared/config';

import styles from './VanishedConnectorsWarning.module.css';

// Managed (remote) connectors present in `previous` and absent in `current`,
// minus the ones removed through the in-app Remove (`excluded`). Only remote
// entries count: local/unknown entries are not managed by xCLAUDE, and a
// reconnect never trips this — replaceRemoteInConfig overwrites the entry in
// one atomic write, so it exists in every observable snapshot.
export function diffVanishedConnectors(
  previous: StatusResult | null,
  current: StatusResult | null,
  excluded: ReadonlySet<string>,
): string[] {
  if (previous === null || current === null) return [];
  if (!previous.ok || !current.ok) return [];
  const currentNames = new Set(toConnectors(current.entries).map((c) => c.name));
  return toConnectors(previous.entries)
    .filter((c) => c.type === 'remote')
    .map((c) => c.name)
    .filter((n) => !currentNames.has(n) && !excluded.has(n));
}

// Append without duplicates, preserving order; returns prev UNCHANGED (same
// reference) when nothing new, so the state setter skips the re-render.
export function appendUniqueNames(
  prev: readonly string[],
  add: readonly string[],
): readonly string[] {
  const fresh = add.filter((n) => !prev.includes(n));
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

// Ages the in-app-removes set so it never grows unbounded: once a removed name
// has left the `previous` snapshot, the remove has fully aged out of the
// snapshot window — any LATER disappearance can only come from a subsequent
// re-add, which must notify again, so the exclusion is dropped.
export function pruneAgedRemoves(removes: Set<string>, previous: StatusResult): void {
  if (!previous.ok) return;
  const prevNames = new Set(toConnectors(previous.entries).map((c) => c.name));
  for (const name of removes) {
    if (!prevNames.has(name)) removes.delete(name);
  }
}

export interface VanishedConnectorsWarningProps {
  readonly names: readonly string[];
  /** Primary action: open the Add connector modal. Does NOT dismiss. */
  readonly onReAdd: () => void;
  /** Explicit dismiss: clears the notice entirely. */
  readonly onDismiss: () => void;
}

// '"a"', '"a" and "b"', '"a", "b" and "c"' — subject of the body sentence.
function quotedList(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]!}`;
}

/**
 * Informative notice for F2-04 step 2: managed connectors that disappeared
 * from claude_desktop_config.json without an in-app Remove (another program
 * rewrote the config). App-level sibling of HealthWarning and
 * ResidualCredentialsWarning; role="status", warning palette, memory-only,
 * accumulates names across firings until the explicit Dismiss. Returns null
 * with an empty list.
 */
export function VanishedConnectorsWarning({
  names,
  onReAdd,
  onDismiss,
}: VanishedConnectorsWarningProps): ReactElement | null {
  if (names.length === 0) return null;

  const subject = quotedList(names);
  const verb =
    names.length === 1
      ? 'was removed from your Claude Desktop config by another program and is no longer audited'
      : 'were removed from your Claude Desktop config by another program and are no longer audited';

  return (
    <div className={styles['warning']} role="status">
      <p className={styles['title']}>Connectors removed outside xCLAUDE</p>
      <p className={styles['body']}>
        {subject} {verb}.
      </p>
      <div className={styles['actions']}>
        <button type="button" className={styles['reAddButton']} onClick={onReAdd}>
          Re-add connectors
        </button>
        <button
          type="button"
          className={styles['dismissButton']}
          onClick={onDismiss}
          aria-label="Dismiss removed-connectors notice"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
