import { useState, type ReactElement } from 'react';

import { toConnectors, type Connector } from '@xcg/shared/config/connectors';
import type { StatusResult } from '@xcg/shared/config';

import { ConnectorInspector } from './ConnectorInspector.js';
import { errorMessage } from './config-messages.js';
import { RemoteConnectors } from './RemoteConnectors.js';
import { SelfTest } from './SelfTest.js';

import styles from './Setup.module.css';

export interface SetupProps {
  readonly status: StatusResult | null;
  readonly onRefresh: () => void;
  readonly onOpenInDetections: (name: string) => void;
  readonly onAudit: (name: string) => void;
}

const CONNECTOR_GROUPS: readonly {
  readonly status: Connector['status'];
  readonly title: string;
}[] = [
  { status: 'not-audited', title: 'Not audited' },
  { status: 'audited', title: 'Auditing' },
  { status: 'unsupported', title: 'Unsupported' },
];

export function Setup({ status, onRefresh, onOpenInDetections, onAudit }: SetupProps): ReactElement {
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Loading state while status hasn't arrived yet from App.tsx's mount effect.
  if (status === null) {
    return (
      <div className={styles['container']}>
        <div className={styles['loading']}>Loading config…</div>
      </div>
    );
  }

  // Error reading the config (parse error, unreadable, etc). Status discriminator.
  if (!status.ok) {
    return (
      <div className={styles['container']}>
        <div className={styles['errorPanel']}>{errorMessage(status.error)}</div>
        <button
          type="button"
          className={styles['refreshButton']}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>
    );
  }

  const { configPresent, entries } = status;
  const connectors = toConnectors(entries);
  const auditingCount = connectors.filter((c) => c.status === 'audited').length;
  const notAuditedCount = connectors.filter((c) => c.status === 'not-audited').length;
  const unsupportedCount = connectors.filter((c) => c.status === 'unsupported').length;
  const selectedConnector = connectors.find((c) => c.name === selectedName) ?? null;

  return (
    <div className={styles['container']}>
      {connectors.length > 0 ? (
        <>
          <div className={styles['summary']}>
            <b>{connectors.length}</b> {connectors.length === 1 ? 'connector' : 'connectors'}
            {' · '}<b>{auditingCount}</b> auditing
            {' · '}<b>{notAuditedCount}</b> not audited
            {unsupportedCount > 0 ? <>{' · '}<b>{unsupportedCount}</b> unsupported</> : null}
          </div>
          <div className={styles['masterDetail']}>
          <div className={styles['list']}>
            {CONNECTOR_GROUPS.map((g) => {
              const items = connectors.filter((c) => c.status === g.status);
              if (items.length === 0) {
                return null;
              }
              return (
                <div key={g.status} className={styles['group']}>
                  <div className={styles['groupHeader']}>
                    <span className={styles['groupTitle']}>{g.title}</span>
                    <span className={styles['groupCount']}>{items.length}</span>
                  </div>
                  <ul className={styles['entries']}>
                    {items.map((c) => (
                      <li
                        key={c.name}
                        className={
                          c.name === selectedName
                            ? `${styles['entry']} ${styles['entrySelected']}`
                            : styles['entry']
                        }
                        role="button"
                        tabIndex={0}
                        aria-pressed={c.name === selectedName}
                        onClick={() => setSelectedName(c.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedName(c.name);
                          }
                        }}
                      >
                        <span className={styles['entryName']}>{c.name}</span>
                        <span className={styles['entryKind']}>{c.type}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className={styles['inspector']}>
            {selectedConnector !== null ? (
              <ConnectorInspector
                connector={selectedConnector}
                onOpenInDetections={onOpenInDetections}
                onAudit={onAudit}
              />
            ) : (
              <p className={styles['inspectorEmpty']}>Select a connector to inspect.</p>
            )}
          </div>
        </div>
        </>
      ) : (
        <div className={styles['empty']}>
          <span className={styles['emptyBadge']} aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <h2 className={styles['emptyHeading']}>See what Claude does.</h2>
          <p className={styles['emptyDetail']}>
            Every tool call Claude makes, classified by risk — 6 categories, 4 severity levels.
          </p>
          <p className={styles['emptyDetail']}>Audited locally. No account.</p>
          <p className={styles['emptyHint']}>
            {!configPresent
              ? 'Claude Desktop has no MCP config yet. Open Claude Desktop, add at least one MCP server, then come back here to install xCLAUDE Gateway.'
              : 'Local MCP servers already in your Claude config will appear here automatically.'}
          </p>
        </div>
      )}

      <RemoteConnectors onRefresh={onRefresh} />

      <SelfTest />
    </div>
  );
}
