// One connector change, one row — never one per tool. A single vendor release
// in the production trail moved 52 tools at once; fifty-two rows would bury
// the one that carried a finding.

import type { KeyboardEvent } from 'react';

import type { ConnectorChangeView } from '../lib/xcgApi.js';
import { Badge } from './Badge.js';
import { changeTitle, detailsLine } from './change-copy.js';
import { formatTimestamp } from './detections-format.js';
import { topSeverity } from '../hooks/useChangePage.js';

import styles from './ChangeRow.module.css';

interface ChangeRowProps {
  row: ConnectorChangeView;
  selected: boolean;
  onClick: () => void;
}

export function ChangeRow({ row, selected, onClick }: ChangeRowProps): JSX.Element {
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  const severity = topSeverity(row);
  const className = selected ? `${styles['row']} ${styles['rowSelected']}` : styles['row'];

  return (
    <div className={className} role="button" tabIndex={0} onClick={onClick} onKeyDown={handleKeyDown}>
      <span className={styles['timestamp']}>{formatTimestamp(row.ts)}</span>
      {/* No finding means no severity. A LOW badge here would read as "a small
          problem" when the truth is "no problem any rule could name" — and
          that is 197 of 217 real changes. REVIEW is not a severity either: it
          is a heuristic asking for a look, and it looks different on purpose. */}
      {/* One component for all three marks, so REVIEW and the no-findings dash
          share the severity pill's exact box. A mark that is a couple of
          pixels off reads as a different kind of thing. */}
      <Badge severity={severity ?? (row.attention.level === 'review_recommended' ? 'review' : 'none')} />
      <span className={styles['change']}>
        {changeTitle(row)}
        {row.review_status === 'reviewed' ? (
          <span className={styles['reviewedMark']} title="Marked as reviewed">
            ✓
          </span>
        ) : null}
      </span>
      <span className={styles['mcp']}>{row.mcp}</span>
      <span className={styles['details']}>{detailsLine(row)}</span>
    </div>
  );
}
