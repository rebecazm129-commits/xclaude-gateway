import type { Severity } from '../../shared/types.js';

import styles from './Badge.module.css';

export function Badge({ severity }: { severity: Severity }): JSX.Element {
  return (
    <span className={`${styles['badge']} ${styles[`badge_${severity}`]}`}>
      {severity.toUpperCase()}
    </span>
  );
}
