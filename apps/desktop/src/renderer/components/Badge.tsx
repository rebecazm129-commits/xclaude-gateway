import type { Severity } from '../../shared/types.js';

import styles from './Badge.module.css';

/**
 * The severity pill, plus two marks that are NOT severities.
 *
 * `review` is a heuristic asking for a look and `none` is "no rule said
 * anything" — neither is a grade, so neither is tinted. They live here rather
 * than in their own component so they inherit the pill's exact size, padding
 * and baseline: a mark half a pixel off in the SEVERITY column reads as a
 * different kind of thing, which is the one impression it must not give.
 */
export type BadgeKind = Severity | 'review' | 'none';

export function Badge({ severity }: { severity: BadgeKind }): JSX.Element {
  if (severity === 'none') {
    return (
      <span className={`${styles['badge']} ${styles['badge_none']}`} title="No findings">
        —
      </span>
    );
  }
  return (
    <span className={`${styles['badge']} ${styles[`badge_${severity}`]}`}>
      {severity.toUpperCase()}
    </span>
  );
}
