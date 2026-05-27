import type { Ref } from 'react';

import styles from './FilterDropdown.module.css';

interface Props<T extends string> {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  onChange: (next: readonly T[]) => void;
  isOpen: boolean;
  onToggle: () => void;
  dropdownRef?: Ref<HTMLDivElement>;
}

export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
  isOpen,
  onToggle,
  dropdownRef,
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

  return (
    <div className={styles['dropdown']} ref={dropdownRef}>
      <button
        type="button"
        className={styles['trigger']}
        onClick={onToggle}
      >
        {label} ({selected.length}/{options.length}) {isOpen ? '▴' : '▾'}
      </button>
      {isOpen && (
        <div className={styles['menu']}>
          {options.map((option) => (
            <label key={option} className={styles['option']}>
              <input
                type="checkbox"
                checked={selectedSet.has(option)}
                onChange={() => toggle(option)}
              />
              {option}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
