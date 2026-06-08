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
}

const CONNECTOR_GROUPS: readonly {
  readonly status: Connector['status'];
  readonly title: string;
}[] = [
  { status: 'not-audited', title: 'Not audited' },
  { status: 'audited', title: 'Auditing' },
  { status: 'unsupported', title: 'Unsupported' },
];

export function Setup({ status, onRefresh }: SetupProps): ReactElement {
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
  const selectedConnector = connectors.find((c) => c.name === selectedName) ?? null;

  return (
    <div className={styles['container']}>
      <div className={styles['intro']}>
        {!configPresent ? (
          <p className={styles['notice']}>
            Claude Desktop has no MCP config yet. Open Claude Desktop, add at least
            one MCP server, then come back here to install xCLAUDE Gateway.
          </p>
        ) : null}
      </div>

      {configPresent ? (
        <>
          <div className={styles['masterDetail']}>
            <div className={styles['list']}>
              {connectors.length > 0 ? (
                CONNECTOR_GROUPS.map((g) => {
                  const items = connectors.filter(
                    (c) => c.status === g.status,
                  );
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
                })
              ) : (
                <div className={styles['entriesEmpty']}>
                  No MCP servers in the config yet.
                </div>
              )}
            </div>

            <div className={styles['inspector']}>
              {selectedConnector !== null ? (
                <ConnectorInspector connector={selectedConnector} />
              ) : (
                <p className={styles['inspectorEmpty']}>Select a connector to inspect.</p>
              )}
            </div>
          </div>

          <div className={styles['introBlock']}>
            <p className={styles['introHeading']}>See what Claude does.</p>
            <p className={styles['introDetail']}>Every tool call Claude makes, classified by risk. 6 categories, 4 severity levels.</p>
            <p className={styles['introTag']}>Audited locally. No account.</p>
          </div>
        </>
      ) : null}

      <RemoteConnectors onRefresh={onRefresh} />

      <SelfTest />
    </div>
  );
}
