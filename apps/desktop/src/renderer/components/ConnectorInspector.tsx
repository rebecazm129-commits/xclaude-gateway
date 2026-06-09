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

const STATUS_DOT: Record<Connector['status'], string> = {
  audited: styles['dotAudited']!,
  'not-audited': styles['dotNotAudited']!,
  unsupported: styles['dotUnsupported']!,
};

const TYPE_LABEL: Record<Connector['type'], string> = {
  remote: 'Remote',
  local: 'Local',
  unknown: 'Unknown',
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
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const calls7d = detections.filter(
    (e): e is DetectionEvent =>
      e.type === 'mcp.request' &&
      e.mcp === connector.name &&
      new Date(e.ts).getTime() >= weekAgoMs,
  );
  const flagged7d = calls7d.filter(
    (e) => e.detection.category !== 'tool_call_allowed',
  );
  const recentFlagged = flagged7d.slice(0, 8);

  return (
    <div className={styles['root']}>
      <div className={styles['head']}>
        <span className={styles['headName']}>{connector.name}</span>
        <span className={styles['headType']}>{TYPE_LABEL[connector.type]}</span>
        <span className={styles['headStatus']}>
          <span className={`${styles['dot']} ${STATUS_DOT[connector.status]}`} />
          {STATUS_LABEL[connector.status]}
        </span>
      </div>

      <dl className={styles['rows']}>
        <div className={styles['row']}>
          <dt className={styles['label']}>Transport</dt>
          <dd className={styles['value']}>{TRANSPORT_LABEL[connector.type]}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Endpoint</dt>
          <dd className={styles['value']}>{connector.endpoint ?? '—'}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Calls (7d)</dt>
          <dd className={styles['value']}>{calls7d.length} audited · {flagged7d.length} flagged</dd>
        </div>
      </dl>

      <div className={styles['flagged']}>
        <h3 className={styles['flaggedTitle']}>Recent flagged calls</h3>
        {recentFlagged.length > 0 ? (
          <ul className={styles['flaggedList']}>
            {recentFlagged.map((e) => (
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
