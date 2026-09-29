// The hook-update offer: a compact card in the Claude Code tab, lined up with
// the severity cards (same surface band, inset, radius and border). Update
// hooks, or Not now — which hides it until the set of pending changes
// differs. A custom hook path is reported, never replaced. The confirmation
// after an update is a toast (Toasts.tsx).
import type { ReactElement } from 'react';

import type { CchookHooksCheck, HookUpdatePrefs } from '../../shared/types.js';
import { hookUpdateDismissed, hookUpdateKey } from '../../shared/types.js';

import styles from './CchookUpdateCard.module.css';
import setup from './Setup.module.css';
import footer from './AuditFooter.module.css';

export const CCHOOK_UPDATE_TITLE = 'New Claude Code coverage available';
export const CCHOOK_UPDATE_CARD_TEXT = 'Record when MCP servers request input from you. A backup is created first.';
export const CCHOOK_UPDATE_BUTTON = 'Update hooks';
export const CCHOOK_NOT_NOW = 'Not now';
export const CCHOOK_CUSTOM_PATH_TEXT =
  "A custom xCLAUDE hook path was found. xCLAUDE won't replace it automatically. Update it manually or reinstall the hook from Sources.";

export interface CchookUpdateCardProps {
  readonly check: CchookHooksCheck | undefined;
  readonly prefs: HookUpdatePrefs | undefined;
  readonly error: string | null;
  readonly onUpdate: () => void;
  readonly onNotNow: (key: string) => void;
}

export function CchookUpdateCard({ check, prefs, error, onUpdate, onNotNow }: CchookUpdateCardProps): ReactElement | null {
  const issues = check?.state === 'outdated' ? check.issues : [];
  const key = hookUpdateKey(check);
  const fixable = key !== '' && !hookUpdateDismissed(prefs, key);
  const custom = issues.some((i) => i.problem === 'custom_path');
  if (!fixable && !custom) return null;
  return (
    <div className={styles['band']}>
      <div className={styles['card']} role="status" data-testid="cchook-update-card">
        <div className={styles['text']}>
          {fixable && (
            <p className={styles['line']}>
              <strong>{CCHOOK_UPDATE_TITLE}</strong>
              <br />
              {CCHOOK_UPDATE_CARD_TEXT}
            </p>
          )}
          {custom && <p className={styles['line']}>{CCHOOK_CUSTOM_PATH_TEXT}</p>}
          {error !== null && <p className={styles['line']}>{error}</p>}
        </div>
        {fixable && (
          <div className={styles['actions']}>
            <button type="button" className={setup['addButton']} onClick={onUpdate}>
              {CCHOOK_UPDATE_BUTTON}
            </button>
            <button type="button" className={footer['footerLink']} onClick={() => onNotNow(key)}>
              {CCHOOK_NOT_NOW}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
