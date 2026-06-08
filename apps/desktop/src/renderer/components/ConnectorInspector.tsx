import { type ReactElement } from 'react';

import type { Connector } from '@xcg/shared/config/connectors';

import type { DetectionEvent } from '../../shared/types.js';
import { usePolledDetections } from '../hooks/usePolledDetections.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, formatTimestamp } from './detections-format.js';

import styles from './ConnectorInspector.module.css';

const STATUS_LABEL: Record<Connector['status'], string> = {
  audited: 'Auditing',
  'not-audited': 'Not audited',
  unsupported: 'Unsupported',
};

const TRANSPORT_LABEL: Record<Connector['type'], string> = {
  remote: 'HTTP',
  local: 'stdio',
  unknown: '—',
};

interface ConnectorInspectorProps {
  connector: Connector;
}

export function ConnectorInspector({ connector }: ConnectorInspectorProps): ReactElement {
  const detections = usePolledDetections();
  const flagged = detections
    .filter(
      (e): e is DetectionEvent =>
        e.type === 'mcp.request' &&
        e.mcp === connector.name &&
        e.detection.category !== 'tool_call_allowed',
    )
    .slice(0, 8);

  return (
    <div className={styles['root']}>
      <h2 className={styles['title']}>{connector.name}</h2>
      <dl className={styles['rows']}>
        <div className={styles['row']}>
          <dt className={styles['label']}>Status</dt>
          <dd className={styles['value']}>{STATUS_LABEL[connector.status]}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Transport</dt>
          <dd className={styles['value']}>{TRANSPORT_LABEL[connector.type]}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Endpoint</dt>
          <dd className={styles['value']}>{connector.endpoint ?? '—'}</dd>
        </div>
      </dl>

      <div className={styles['flagged']}>
        <h3 className={styles['flaggedTitle']}>Recent flagged calls</h3>
        {flagged.length > 0 ? (
          <ul className={styles['flaggedList']}>
            {flagged.map((e) => (
              <li key={e.id} className={styles['flaggedRow']}>
                <Badge severity={e.detection.severity} />
                <span className={styles['flaggedTool']}>{e.toolName ?? e.method}</span>
                <span className={styles['flaggedCategory']}>{CATEGORY_LABELS[e.detection.category]}</span>
                <span className={styles['flaggedTime']}>{formatTimestamp(e.ts)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles['flaggedEmpty']}>No flagged calls.</p>
        )}
      </div>
    </div>
  );
}
