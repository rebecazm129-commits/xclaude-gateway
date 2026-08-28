import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';

import { Tooltip } from './Tooltip.js';

import styles from './FilterDropdown.module.css';

interface Props<T extends string> {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  onChange: (next: readonly T[]) => void;
  isOpen: boolean;
  onToggle: () => void;
  dropdownRef?: Ref<HTMLDivElement>;
  /** Human-readable label per option; defaults to the raw option value
   *  (Severity/Category keep their current rendering untouched). May return
   *  rich content (F2.4: the CC Session chip renders a human label with the
   *  short hash dimmed at the end). */
  formatOption?: (option: T) => ReactNode;
  /** Tooltip for the trigger button — the shared CSS Tooltip (commit 5l),
   *  not the native title: the OS ~1s delay restarts on any mutation of the
   *  hovered element, which live (n/m) chip labels do constantly. */
  tooltip?: string;
}

/** Gap kept between the menu's bottom edge and the window's. */
const MENU_BOTTOM_MARGIN_PX = 16;

export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
  isOpen,
  onToggle,
  dropdownRef,
  formatOption,
  tooltip,
}: Props<T>): JSX.Element {
  const selectedSet = new Set(selected);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);

  // The menu's max-height is MEASURED from its own viewport position — never
  // derived from a chrome constant (the titlebar lesson, Detections.tsx:70:
  // any sibling the constant didn't know about breaks the fixed sum). The
  // menu always opens downward (.menu top: calc(100% + 4px)), so the space it
  // may occupy is exactly window bottom − its own top − a breathing margin.
  // useLayoutEffect runs before paint (no flash of a clipped menu); the
  // resize listener keeps it true while open — chips reflow on narrow
  // windows, so the trigger's Y can change with width too.
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const measure = (): void => {
      const el = menuRef.current;
      if (el === null) return;
      const available =
        window.innerHeight - el.getBoundingClientRect().top - MENU_BOTTOM_MARGIN_PX;
      if (available > 0) setMenuMaxHeight(available);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isOpen]);

  function toggle(option: T): void {
    const next = new Set(selectedSet);
    if (next.has(option)) {
      next.delete(option);
    } else {
      next.add(option);
    }
    onChange(options.filter((o) => next.has(o)));
  }

  const trigger = (
    <button
      type="button"
      className={styles['trigger']}
      onClick={onToggle}
    >
      {label} ({selected.length}/{options.length}) {isOpen ? '▴' : '▾'}
    </button>
  );

  return (
    <div className={styles['dropdown']} ref={dropdownRef}>
      {tooltip !== undefined ? <Tooltip text={tooltip}>{trigger}</Tooltip> : trigger}
      {isOpen && (
        <div
          className={styles['menu']}
          ref={menuRef}
          style={menuMaxHeight !== null ? { maxHeight: menuMaxHeight } : undefined}
        >
          {/* Scroll lives HERE, not on .menu: the All/None footer below stays
              pinned while long option lists (Session: 25) scroll. */}
          <div className={styles['menuList']}>
            {options.map((option) => (
              <label key={option} className={styles['option']}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(option)}
                  onChange={() => toggle(option)}
                />
                {/* Single-line contract (commit 6): long values ellipsize
                    instead of wrapping the option onto multiple lines. */}
                <span className={styles['optionLabel']}>
                  {formatOption !== undefined ? formatOption(option) : option}
                </span>
              </label>
            ))}
          </div>
          {/* Pie All/None (mockup 28/07): atajos de selección total/vacía. */}
          <div className={styles['menuFooter']}>
            <button
              type="button"
              className={styles['footerAll']}
              data-testid="filter-all"
              onClick={() => onChange(options)}
            >
              All
            </button>
            <button
              type="button"
              className={styles['footerNone']}
              data-testid="filter-none"
              onClick={() => onChange([])}
            >
              None
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
