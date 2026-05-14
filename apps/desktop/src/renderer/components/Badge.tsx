import type { Severity } from '../../shared/types.js';

import styles from './Badge.module.css';

const COLORS: Record<Severity, string> = {
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#ef4444',
  critical: '#7c3aed',
};

export function Badge({ severity }: { severity: Severity }): JSX.Element {
  return (
    <span className={styles['badge']} style={{ background: COLORS[severity] }}>
      {severity.toUpperCase()}
    </span>
  );
}
