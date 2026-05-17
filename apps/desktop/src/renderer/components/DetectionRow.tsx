import type { EnrichableEvent } from '../../shared/types.js';
import { Badge } from './Badge.js';

import styles from './DetectionRow.module.css';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function DetectionRow({ event }: { event: EnrichableEvent }): JSX.Element {
  return (
    <div className={styles['row']}>
      <span className={styles['timestamp']}>{formatTime(event.ts)}</span>
      <Badge severity={event.detection.severity} />
      <span className={styles['category']}>{event.detection.category}</span>
      <span className={styles['mcp']}>{event.mcp}</span>
      {event.type === 'mcp.request' ? (
        <span className={styles['method']}>{event.method}</span>
      ) : (
        <span className={styles['ner']}>[NER]</span>
      )}
    </div>
  );
}
