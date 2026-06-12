import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import styles from './Modal.module.css';

interface ModalProps {
  /** Accessible dialog title; shown in the header and used as the aria-label. */
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Optional pinned footer, below the (flex) body. */
  readonly footer?: ReactNode;
}

/**
 * Centered modal shell with a dimming scrim — the app's first modal, kept
 * deliberately small. Closes on ✕, Esc, and a mousedown on the scrim (outside
 * the panel). Focuses the panel on mount so keyboard users land inside it.
 * Mounted only while visible (the parent renders it conditionally), so the
 * document listeners live only while open — no open-click guard needed.
 */
export function Modal({ title, onClose, children, footer }: ModalProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Close only when the press starts on the scrim itself (not on the panel and
  // dragged out). mousedown — not click — matches the app's overlay intent.
  function handleScrimMouseDown(e: ReactMouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className={styles['scrim']} onMouseDown={handleScrimMouseDown}>
      <div
        ref={panelRef}
        className={styles['panel']}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles['head']}>
          <h2 className={styles['title']}>{title}</h2>
          <button
            type="button"
            className={styles['close']}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className={styles['body']}>{children}</div>
        {footer != null ? <div className={styles['foot']}>{footer}</div> : null}
      </div>
    </div>
  );
}
