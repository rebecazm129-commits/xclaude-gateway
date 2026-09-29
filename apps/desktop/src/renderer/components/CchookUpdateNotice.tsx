import { useEffect, type ReactElement } from 'react';

import type { CchookHooksCheck, HookUpdatePrefs } from '../../shared/types.js';
import { hookUpdateDismissed, hookUpdateKey } from '../../shared/types.js';

// Existing styles only: Detections' neutral retention strip, the primary
// Add-source button, the audit footer's grey text link and the inspector's
// muted small line.
import banner from './Detections.module.css';
import setup from './Setup.module.css';
import footer from './AuditFooter.module.css';
import inspector from './ClaudeCodeInspector.module.css';
import layout from './CchookUpdateNotice.module.css';

export const CCHOOK_UPDATE_TITLE = 'New Claude Code coverage available';
export const CCHOOK_UPDATE_TEXT =
  "Update xCLAUDE's hooks to record when MCP servers request input from you. A backup is created first.";
export const CCHOOK_UPDATE_NOTE = 'Only xCLAUDE-managed entries are changed.';
export const CCHOOK_UPDATE_BUTTON = 'Update hooks';
export const CCHOOK_NOT_NOW = 'Not now';
export const CCHOOK_UPDATED_TEXT = 'Hooks updated.';
export const CCHOOK_CUSTOM_PATH_TEXT =
  "A custom xCLAUDE hook path was found. xCLAUDE won't replace it automatically. Update it manually or reinstall the hook from Sources.";

/** How long the "Hooks updated." confirmation stays. */
export const UPDATED_MS = 4_000;

export interface CchookUpdateNoticeProps {
  /** cchook:status hookCheck; undefined before the first poll. */
  readonly check: CchookHooksCheck | undefined;
  /** The "Not now" mark (cchook:status). */
  readonly prefs: HookUpdatePrefs | undefined;
  /** An update was written just now: show the confirmation. */
  readonly updated: boolean;
  /** Last update failure, shown verbatim; null when none. */
  readonly error: string | null;
  /** The explicit action (cchook:update). Nothing updates without it. */
  readonly onUpdate: () => void;
  readonly onNotNow: (key: string) => void;
  /** Called when the confirmation's time is up. */
  readonly onDismissUpdated: () => void;
}

/**
 * The Claude Code tab's notice for an existing hook install that lacks events
 * or arguments this build writes. Neutral and compact: an offer, not a
 * warning. Update hooks, or Not now — which hides it until the set of pending
 * changes differs. A custom hook path is reported, never replaced. After an
 * update, a short "Hooks updated.".
 */
export function CchookUpdateNotice({
  check,
  prefs,
  updated,
  error,
  onUpdate,
  onNotNow,
  onDismissUpdated,
}: CchookUpdateNoticeProps): ReactElement | null {
  useEffect(() => {
    if (!updated) return undefined;
    const timer = setTimeout(onDismissUpdated, UPDATED_MS);
    return () => clearTimeout(timer);
  }, [updated, onDismissUpdated]);

  if (updated) {
    return (
      <div className={banner['retentionBanner']} role="status" data-testid="cchook-update-notice">
        {CCHOOK_UPDATED_TEXT}
      </div>
    );
  }

  const issues = check?.state === 'outdated' ? check.issues : [];
  const key = hookUpdateKey(check);
  const fixable = key !== '' && !hookUpdateDismissed(prefs, key);
  const custom = issues.some((i) => i.problem === 'custom_path');
  if (!fixable && !custom) return null;

  return (
    <div className={banner['retentionBanner']} role="status" data-testid="cchook-update-notice">
      {fixable && (
        <div className={layout['row']}>
          <div className={layout['text']}>
            <p className={layout['line']}>
              <strong>{CCHOOK_UPDATE_TITLE}</strong>
              <br />
              {CCHOOK_UPDATE_TEXT}
            </p>
            <p className={inspector['flaggedEmpty']}>{CCHOOK_UPDATE_NOTE}</p>
          </div>
          <div className={layout['actions']}>
            <button type="button" className={setup['addButton']} onClick={onUpdate}>
              {CCHOOK_UPDATE_BUTTON}
            </button>
            <button type="button" className={footer['footerLink']} onClick={() => onNotNow(key)}>
              {CCHOOK_NOT_NOW}
            </button>
          </div>
        </div>
      )}
      {custom && <p className={layout['line']}>{CCHOOK_CUSTOM_PATH_TEXT}</p>}
      {error !== null && <p className={layout['line']}>{error}</p>}
    </div>
  );
}
