import type { TimeRange } from '../../shared/types.js';

import styles from './TimeFilter.module.css';

export type { TimeRange };

const TIME_RANGE_OPTIONS: readonly { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: 'all', label: 'All' },
];

interface Props {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
}

export function TimeFilter({ value, onChange }: Props): JSX.Element {
  return (
    <div className={styles['segmented']} role="group" aria-label="Time range">
      {TIME_RANGE_OPTIONS.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`${styles['option']} ${isActive ? styles['optionActive'] : ''}`}
            onClick={() => onChange(opt.value)}
            aria-pressed={isActive}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
