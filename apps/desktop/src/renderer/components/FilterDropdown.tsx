import { useState } from 'react';

import styles from './FilterDropdown.module.css';

interface Props<T extends string> {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  onChange: (next: readonly T[]) => void;
}

export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false);
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
    <div className={styles['dropdown']}>
      <button
        type="button"
        className={styles['trigger']}
        onClick={() => setOpen((v) => !v)}
      >
        {label} ({selected.length}/{options.length}) {open ? '▴' : '▾'}
      </button>
      {open && (
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
