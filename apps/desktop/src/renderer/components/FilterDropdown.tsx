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
        <div className={styles['menu']}>
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
      )}
    </div>
  );
}
