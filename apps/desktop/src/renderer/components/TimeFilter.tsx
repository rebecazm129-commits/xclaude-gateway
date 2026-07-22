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
  /** Opt-in 'Custom' segment (F2.4 delta final). Both views pass it since the
   *  Detections filter parity (22/07); the flag stays opt-in for any future
   *  caller that wants only the four presets. */
  allowCustom?: boolean;
}

export function TimeFilter({ value, onChange, allowCustom = false }: Props): JSX.Element {
  const options = allowCustom
    ? [...TIME_RANGE_OPTIONS, { value: 'custom' as TimeRange, label: 'Custom' }]
    : TIME_RANGE_OPTIONS;
  return (
    <div className={styles['segmented']} role="group" aria-label="Time range">
      {options.map((opt) => {
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
