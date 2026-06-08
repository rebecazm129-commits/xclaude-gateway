import type { KeyboardEvent } from 'react';

import type { EnrichableEvent } from '../../shared/types.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, formatTimestamp } from './detections-format.js';

import styles from './DetectionRow.module.css';

interface DetectionRowProps {
  event: EnrichableEvent;
  selected: boolean;
  onClick: () => void;
}

export function DetectionRow({ event, selected, onClick }: DetectionRowProps): JSX.Element {
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  const className = selected
    ? `${styles['row']} ${styles['rowSelected']}`
    : styles['row'];

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <span className={styles['timestamp']}>{formatTimestamp(event.ts)}</span>
      <Badge severity={event.detection.severity} />
      <span className={styles['category']}>
        {CATEGORY_LABELS[event.detection.category]}
      </span>
      <span className={styles['mcp']}>{event.mcp}</span>
      {event.type === 'mcp.request' ? (
        <span className={styles['method']}>
          {event.toolName ?? event.method}
        </span>
      ) : (
        <span className={styles['ner']}>[NER]</span>
      )}
    </div>
  );
}
