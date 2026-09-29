// Toasts: informational notices in the bottom-right corner, stacked, above
// the audit footer (so Export and the other footer controls stay reachable).
// The stack is ONE polite live region, always mounted, so a toast added to it
// is announced. A persistent toast (spool drops) stays until its action; the
// others close on their own.
import { useEffect, type ReactElement } from 'react';

import styles from './Toasts.module.css';
import footer from './AuditFooter.module.css';

export interface ToastItem {
  id: string;
  kind: 'warning' | 'success';
  text: string;
  /** Persistent toasts stay until their action; the others close after
   *  autoCloseMs. */
  persistent?: boolean;
  autoCloseMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
}

export const TOAST_AUTO_CLOSE_MS = 4_000;
/** Distance of the stack from the window's bottom edge: the audit footer is
 *  ~53px tall (12px padding + the Export button), plus a gap. */
export const TOAST_BOTTOM_PX = 72;

function Icon({ kind }: { kind: ToastItem['kind'] }): ReactElement {
  return kind === 'warning' ? (
    <svg className={`${styles['icon']} ${styles['iconWarning']}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.9" r="0.8" fill="currentColor" />
    </svg>
  ) : (
    <svg className={`${styles['icon']} ${styles['iconSuccess']}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 8.2 7.1 10.3 11 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Toast({ item }: { item: ToastItem }): ReactElement {
  const { persistent, autoCloseMs, onClose } = item;
  useEffect(() => {
    if (persistent === true || onClose === undefined) return undefined;
    const timer = setTimeout(onClose, autoCloseMs ?? TOAST_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [persistent, autoCloseMs, onClose]);
  return (
    <div className={styles['toast']} data-testid={`toast-${item.id}`}>
      <Icon kind={item.kind} />
      <p className={styles['text']}>{item.text}</p>
      {item.actionLabel !== undefined && (
        <button type="button" className={`${footer['footerLink']} ${styles['action']}`} onClick={item.onAction}>
          {item.actionLabel}
        </button>
      )}
    </div>
  );
}

export function ToastStack({ toasts }: { toasts: readonly ToastItem[] }): ReactElement {
  // Mounted even when empty: a live region must exist before the content it
  // announces is added.
  return (
    <div
      className={styles['stack']}
      style={{ bottom: TOAST_BOTTOM_PX }}
      role="status"
      aria-live="polite"
      data-testid="toast-stack"
    >
      {toasts.map((t) => (
        <Toast key={t.id} item={t} />
      ))}
    </div>
  );
}

/** The spool-cap toast text. */
export function droppedToastText(count: number): string {
  return count === 1
    ? "1 Claude Code event wasn't recorded because the staging area reached its limit."
    : `${count} Claude Code events weren't recorded because the staging area reached its limit.`;
}
