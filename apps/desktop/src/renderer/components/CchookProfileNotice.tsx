import { useEffect, useState, type ReactElement } from 'react';

import type { UnauditedClaudeProfile } from '../../shared/types.js';
import { CCHOOK_COPIED, CCHOOK_COPY_BUTTON, COPIED_MS } from './CchookManagedNotice.js';

// The neutral compact card of the hook-update offer (same band, inset, border)
// and its quiet link: a possibility, so less weight than the orange notices
// for lost coverage (hook removed, settings managed externally).
import card from './CchookUpdateCard.module.css';
import own from './CchookProfileNotice.module.css';
import footer from './AuditFooter.module.css';

export const CCHOOK_PROFILE_TITLE = 'Another Claude Code profile may not be audited';
export function cchookProfileText(path: string): string {
  return `xCLAUDE found ${path}/settings.json without the xCLAUDE hook. If you use this profile, add the xCLAUDE hook configuration manually.`;
}
export const CCHOOK_PROFILE_SCOPE = 'xCLAUDE installs hooks automatically only in ~/.claude.';
export const CCHOOK_PROFILE_DISMISS = 'Dismiss';

export interface CchookProfileNoticeProps {
  readonly profile: UnauditedClaudeProfile;
  /** Hides this folder's notice for good (persisted by path in the main process). */
  readonly onDismiss: (path: string) => void;
  /** Clipboard writer; default navigator.clipboard.writeText. */
  readonly copy?: (text: string) => Promise<void>;
}

/**
 * A ~/.claude-* directory whose settings.json lacks our hook — maybe a
 * CLAUDE_CONFIG_DIR profile. Informational: no toast, no count, nothing
 * installed. The way forward is the same snippet the managed-settings notice
 * offers, pasted by the user; Dismiss hides it for that folder.
 */
export function CchookProfileNotice({ profile, onDismiss, copy }: CchookProfileNoticeProps): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  function handleCopy(): void {
    const write = copy ?? ((text: string) => navigator.clipboard.writeText(text));
    // "Copied" only once the clipboard write resolved — never on a failure.
    void write(profile.snippet)
      .then(() => setCopied(true))
      .catch((err) => console.error('copy hook configuration failed:', err));
  }

  return (
    <div className={card['band']}>
      <div className={card['card']} role="status" data-testid="cchook-profile-notice">
        <span className={own['icon']} aria-hidden="true">
          i
        </span>
        <div className={card['text']}>
          <p className={card['line']}>
            <strong>{CCHOOK_PROFILE_TITLE}</strong>
            <br />
            {cchookProfileText(profile.path)}
          </p>
          <p className={`${card['line']} ${own['muted']}`}>{CCHOOK_PROFILE_SCOPE}</p>
        </div>
        <div className={card['actions']}>
          {/* Outline, not the filled primary: this notice reports a possibility. */}
          <button type="button" className={footer['exportButton']} onClick={handleCopy}>
            {copied ? CCHOOK_COPIED : CCHOOK_COPY_BUTTON}
          </button>
          <button type="button" className={footer['footerLink']} onClick={() => onDismiss(profile.path)}>
            {CCHOOK_PROFILE_DISMISS}
          </button>
        </div>
      </div>
    </div>
  );
}
