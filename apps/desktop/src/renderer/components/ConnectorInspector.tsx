import { type ReactElement } from 'react';

import type { Connector } from '@xcg/shared/config/connectors';

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
    </div>
  );
}
