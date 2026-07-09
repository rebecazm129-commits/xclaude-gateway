import type { ReactElement } from 'react';

import type { RemoveRemoteResult } from '@xcg/shared/config';

import styles from './ResidualCredentialsWarning.module.css';

// Mirror of the proxy's CREDENTIAL_KINDS (packages/proxy/src/credentials.ts):
// a connector stores three Keychain items, `${name}:${kind}` under the service
// com.xclaude.gateway. The banner names them so the user can find and delete
// the leftovers in Keychain Access.
const CREDENTIAL_KINDS = ['tokens', 'client', 'verifier'] as const;

// Accumulates connector names whose remove left credentials behind (ok+wrote
// with tokensCleared === false — the best-effort Keychain clear failed). No
// duplicates: a repeated failed remove of the same name keeps one entry. Any
// other result returns prev UNCHANGED (same reference → no re-render).
export function accumulateResidualCredentials(
  prev: readonly string[],
  name: string,
  result: RemoveRemoteResult,
): readonly string[] {
  if (!(result.ok && result.outcome === 'wrote' && result.tokensCleared === false)) return prev;
  if (prev.includes(name)) return prev;
  return [...prev, name];
}

export interface ResidualCredentialsWarningProps {
  readonly names: readonly string[];
  /** Explicit dismiss: clears the notice (App drops all listed names). */
  readonly onDismiss: () => void;
}

// '"a"', '"a" and "b"', '"a", "b" and "c"' — subject of the body sentence.
function quotedList(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]!}`;
}

/**
 * Informative (non-blocking) notice rendered next to HealthWarning at the App
 * level when a remove succeeded but the best-effort Keychain clear did not
 * (RemoveRemoteOk.tokensCleared === false). Lives above the tabs because the
 * inspector that ran the remove unmounts with the removed entry. Persistent
 * until the user dismisses it; role="status" (informative, not urgent —
 * precedent: the retention banner). Returns null with an empty list.
 */
export function ResidualCredentialsWarning({
  names,
  onDismiss,
}: ResidualCredentialsWarningProps): ReactElement | null {
  if (names.length === 0) return null;

  const subject = quotedList(names);
  const verb =
    names.length === 1
      ? 'was removed, but clearing its stored credentials failed'
      : 'were removed, but clearing their stored credentials failed';
  const items = names
    .map((n) => CREDENTIAL_KINDS.map((k) => `${n}:${k}`).join(', '))
    .join('; ');

  return (
    <div className={styles['warning']} role="status">
      <p className={styles['title']}>Credentials may remain in your Keychain</p>
      <p className={styles['body']}>
        {subject} {verb}. One or more of these items may remain under the service{' '}
        com.xclaude.gateway: <span className={styles['items']}>{items}</span>. You can delete them
        manually in Keychain Access by searching for {'"com.xclaude.gateway"'}.
      </p>
      <div className={styles['actions']}>
        <button
          type="button"
          className={styles['dismissButton']}
          onClick={onDismiss}
          aria-label="Dismiss Keychain credentials notice"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
