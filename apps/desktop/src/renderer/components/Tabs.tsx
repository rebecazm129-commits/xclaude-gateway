import type { ReactElement } from 'react';

import styles from './Tabs.module.css';

export interface TabOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

export interface TabsProps<T extends string> {
  readonly options: readonly TabOption<T>[];
  readonly active: T;
  readonly onChange: (id: T) => void;
}

export function Tabs<T extends string>({
  options,
  active,
  onChange,
}: TabsProps<T>): ReactElement {
  return (
    <nav className={styles['tabs']} role="tablist">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={opt.id === active}
          className={
            opt.id === active
              ? `${styles['tab']} ${styles['tabActive']}`
              : styles['tab']
          }
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </nav>
  );
}
