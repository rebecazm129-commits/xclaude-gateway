import type { ReactElement } from 'react';

import styles from './CchookVanishedWarning.module.css';

export interface CchookVanishedWarningProps {
  /** The persisted hook-integrity notice (cchook:status pendingNotice). */
  readonly notice: { ts: string } | null;
  /** Primary action: re-register the capture hook (cchook:install). */
  readonly onReinstall: () => void;
  /** Explicit dismiss: clears the persisted notice (cchook:dismiss-vanished). */
  readonly onDismiss: () => void;
}

/**
 * Informative notice for the hook-integrity check: the Claude Code capture
 * hook disappeared from ~/.claude/settings.json without an in-app Uninstall
 * (another program — or the agent itself — rewrote the file). App-level
 * sibling of VanishedConnectorsWarning; role="status", warning palette. Unlike
 * its sibling the state is PERSISTED (claude-code/hook-state.json), so both
 * actions round-trip through main and the banner reflects the next polled
 * snapshot. Returns null without a notice.
 */
export function CchookVanishedWarning({
  notice,
  onReinstall,
  onDismiss,
}: CchookVanishedWarningProps): ReactElement | null {
  if (notice === null) return null;

  return (
    <div className={styles['warning']} role="status">
      <p className={styles['title']}>Claude Code hook removed outside xCLAUDE Gateway</p>
      <p className={styles['body']}>
        The Claude Code hook was removed outside xCLAUDE Gateway. Claude Code activity is no
        longer audited.
      </p>
      <div className={styles['actions']}>
        <button type="button" className={styles['reinstallButton']} onClick={onReinstall}>
          Reinstall hook
        </button>
        <button
          type="button"
          className={styles['dismissButton']}
          onClick={onDismiss}
          aria-label="Dismiss Claude Code hook notice"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
