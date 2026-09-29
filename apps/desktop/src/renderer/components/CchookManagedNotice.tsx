import { useEffect, useState, type ReactElement } from 'react';

import type { CchookManagedSettings, CchookStatus } from '../../shared/types.js';

// Same panel as the other hook notices (warning palette): no new visual
// language for a sibling notice.
import styles from './CchookVanishedWarning.module.css';

export const CCHOOK_MANAGED_TITLE = 'Claude Code settings are managed externally';
export const CCHOOK_MANAGED_TEXT: Record<CchookManagedSettings['reason'], string> = {
  symlink:
    "~/.claude/settings.json is a symlink, so xCLAUDE won't modify it automatically. Add the xCLAUDE hook configuration to the file or tool that manages your Claude Code settings.",
  not_regular:
    "~/.claude/settings.json is not a regular file, so xCLAUDE won't modify it automatically. Add the xCLAUDE hook configuration to the file or tool that manages your Claude Code settings.",
  foreign_owner:
    "~/.claude/settings.json is owned by another user account, so xCLAUDE won't modify it automatically. Add the xCLAUDE hook configuration to the file or tool that manages your Claude Code settings.",
};
export const CCHOOK_COPY_BUTTON = 'Copy hook configuration';
export const CCHOOK_COPIED = 'Copied';
/** How long the button reads "Copied" after a successful copy. */
export const COPIED_MS = 2_000;

export interface CchookManagedNoticeProps {
  readonly managed: CchookManagedSettings | null | undefined;
  /** Clipboard writer; default navigator.clipboard.writeText. */
  readonly copy?: (text: string) => Promise<void>;
}

/**
 * Which managed-settings notice to show, if any. After an Install or Update
 * that did not write because the file is managed (`attempted`), that one —
 * while the poll still says the file is managed. Without an attempt, only
 * when our hook is installed and has something the Update would fix: a user
 * who never asked for the hook is not told how to add it.
 */
export function managedNoticeToShow(
  status: CchookStatus | null,
  attempted: CchookManagedSettings | null,
): CchookManagedSettings | null {
  const polled = status?.settingsManaged;
  if (attempted !== null) return polled === null ? null : attempted;
  if (polled === null || polled === undefined) return null;
  const check = status?.hookCheck;
  return check?.state === 'outdated' && check.issues.some((i) => i.problem !== 'custom_path') ? polled : null;
}

/**
 * settings.json is not ours to write (a symlink, not a regular file, or owned
 * by another user): xCLAUDE writes nothing — not even through the symlink —
 * and offers the hook configuration to paste instead. The copied JSON holds
 * only xCLAUDE's own entries, grouped by event.
 */
export function CchookManagedNotice({ managed, copy }: CchookManagedNoticeProps): ReactElement | null {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (managed === null || managed === undefined) return null;

  function handleCopy(): void {
    if (managed === null || managed === undefined) return;
    const write = copy ?? ((text: string) => navigator.clipboard.writeText(text));
    // "Copied" only once the clipboard write resolved — never on a failure.
    void write(managed.snippet)
      .then(() => setCopied(true))
      .catch((err) => console.error('copy hook configuration failed:', err));
  }

  return (
    <div className={styles['warning']} role="status" data-testid="cchook-managed-notice">
      <p className={styles['title']}>{CCHOOK_MANAGED_TITLE}</p>
      <p className={styles['body']}>{CCHOOK_MANAGED_TEXT[managed.reason]}</p>
      {managed.reason === 'symlink' && managed.target !== undefined && (
        <p className={styles['path']} data-testid="cchook-managed-target">
          ~/.claude/settings.json → {managed.target}
        </p>
      )}
      <div className={styles['actions']}>
        <button type="button" className={styles['reinstallButton']} onClick={handleCopy}>
          {copied ? CCHOOK_COPIED : CCHOOK_COPY_BUTTON}
        </button>
      </div>
    </div>
  );
}
