import type { Severity } from '../../shared/types.js';

import styles from './Badge.module.css';

/**
 * The severity pill, plus NONE and REVIEW.
 *
 * NONE is the bottom of the scale — CVSS's qualitative scale has "None" as a
 * level too — so it is the same pill, same box, same alignment as LOW to
 * CRITICAL, filled with the neutral grey rather than a risk hue. REVIEW is not
 * a level at all but a heuristic asking for a look: an outline only, so the
 * two never read as the same thing.
 */
export type BadgeKind = Severity | 'review' | 'none';

export function Badge({ severity }: { severity: BadgeKind }): JSX.Element {
  return (
    <span className={`${styles['badge']} ${styles[`badge_${severity}`]}`}>
      {severity.toUpperCase()}
    </span>
  );
}
