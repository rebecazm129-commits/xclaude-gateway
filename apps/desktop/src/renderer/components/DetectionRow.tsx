import type { Category, EnrichableEvent } from '../../shared/types.js';
import { Badge } from './Badge.js';

import styles from './DetectionRow.module.css';

const CATEGORY_LABELS: Record<Category, string> = {
  credential_detected: 'Credential leak',
  prompt_injection: 'Prompt injection',
  email_send_warning: 'Email send',
  data_export_warning: 'Data export',
  tool_call_allowed: 'Tool call',
  pii_detected: 'PII detected',
};

const MONTH_SHORT: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, '0');
  const month = MONTH_SHORT[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}:${ss}`;
}

export function DetectionRow({ event }: { event: EnrichableEvent }): JSX.Element {
  return (
    <div className={styles['row']}>
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
