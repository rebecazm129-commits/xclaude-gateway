import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import styles from './Tooltip.module.css';

// Lightweight CSS tooltip (F2.4 commit 5l). The native title needs ~1s of OS
// delay (not configurable) and Chromium RESTARTS that timer whenever the
// hovered element mutates — useless on chips whose (n/m) label updates with
// the live poll (the Session bug, commit 5k). This one owns its timer in the
// WRAPPER's state, so child re-renders can't reset it; the tip is a real DOM
// element (role=tooltip), so tests assert what the user actually sees.
// Keyboard: shows on focus, hides on blur; aria-describedby wires the tip to
// the child while visible.

const SHOW_DELAY_MS = 300;

interface TooltipProps {
  readonly text: string;
  readonly children: ReactElement;
}

export function Tooltip({ text, children }: TooltipProps): JSX.Element {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);
  const id = useId();

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function show(): void {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
  }

  function hide(): void {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setVisible(false);
  }

  return (
    <span
      className={styles['wrap']}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {cloneElement(
        children as ReactElement<Record<string, unknown>>,
        visible ? { 'aria-describedby': id } : {},
      )}
      {visible && (
        <span role="tooltip" id={id} className={styles['tip']}>
          {text}
        </span>
      )}
    </span>
  );
}
