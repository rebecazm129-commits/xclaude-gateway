import { useMemo, useState, type ReactElement } from 'react';

import { toConnectors, type Connector } from '@xcg/shared/config/connectors';
import type { ConnectResult, RemoveRemoteResult, StatusResult } from '@xcg/shared/config';

import { AddConnectorModal } from './AddConnectorModal.js';
import { ConnectorInspector } from './ConnectorInspector.js';
import { errorMessage } from './config-messages.js';
import { SelfTest } from './SelfTest.js';
import { usePolledAudit } from '../hooks/usePolledAudit.js';

import styles from './Setup.module.css';

export interface SetupProps {
  readonly status: StatusResult | null;
  readonly onRefresh: () => void;
  readonly onOpenInDetections: (name: string) => void;
  readonly onAudit: (name: string) => void;
  readonly onReconnect: (name: string, url: string) => Promise<ConnectResult>;
  readonly onRemove: (name: string) => Promise<RemoveRemoteResult>;
  /** Open the Settings drawer (the empty-state "Install" step links to it). */
  readonly onOpenSettings: () => void;
}

const CONNECTOR_GROUPS: readonly {
  readonly status: Connector['status'];
  readonly title: string;
}[] = [
  { status: 'not-audited', title: 'Not audited' },
  { status: 'audited', title: 'Auditing' },
  { status: 'unsupported', title: 'Unsupported' },
];

export function Setup({ status, onRefresh, onOpenInDetections, onAudit, onReconnect, onRemove, onOpenSettings }: SetupProps): ReactElement {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { events: detections, authAlerts } = usePolledAudit();
  const alertedMcps = useMemo(() => new Set(authAlerts.map((a) => a.mcp)), [authAlerts]);

  // One pass over all detections → flagged-call count per connector (last 7d).
  // Same predicate the inspector uses (mcp.request, non-allowed category, in
  // window), but aggregated once for every row instead of a filter per row.
  const flaggedByMcp = useMemo(() => {
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const map = new Map<string, number>();
    for (const e of detections) {
      if (
        e.type === 'mcp.request' &&
        e.detection.category !== 'tool_call_allowed' &&
        new Date(e.ts).getTime() >= weekAgoMs
      ) {
        map.set(e.mcp, (map.get(e.mcp) ?? 0) + 1);
      }
    }
    return map;
  }, [detections]);

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

  // Client-side filter: name contains the query (case-insensitive, trimmed).
  // Empty query → includes('') is always true → full list. anyMatch drives the
  // "no results" message. Summary totals stay UNfiltered (computed above).
  const q = query.trim().toLowerCase();
  const anyMatch = connectors.some((c) => c.name.toLowerCase().includes(q));

  return (
    <div className={styles['container']}>
      {connectors.length > 0 ? (
        <>
          <div className={styles['summaryRow']}>
            <div className={styles['summary']}>
              <b>{connectors.length}</b> {connectors.length === 1 ? 'connector' : 'connectors'}
              {' · '}<b>{auditingCount}</b> auditing
              {' · '}<b>{notAuditedCount}</b> not audited
              {unsupportedCount > 0 ? <>{' · '}<b>{unsupportedCount}</b> unsupported</> : null}
            </div>
            <div className={styles['summaryActions']}>
              <input
                type="search"
                className={styles['search']}
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search connectors"
              />
              <button
                type="button"
                className={styles['addButton']}
                onClick={() => setAddOpen(true)}
                aria-haspopup="dialog"
              >
                + Add connector
              </button>
            </div>
          </div>
          <div className={styles['masterDetail']}>
          <div className={styles['list']}>
            {anyMatch ? (
              CONNECTOR_GROUPS.map((g) => {
              const items = connectors.filter(
                (c) => c.status === g.status && c.name.toLowerCase().includes(q),
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
                    {items.map((c) => {
                      const flagged = flaggedByMcp.get(c.name) ?? 0;
                      return (
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
                          <span className={styles['entryNameGroup']}>
                            <span className={styles['entryName']}>{c.name}</span>
                            {alertedMcps.has(c.name) ? (
                              <span
                                className={styles['authWarn']}
                                title="needs re-login"
                                aria-label="needs re-login"
                              >
                                {'⚠︎'}
                              </span>
                            ) : null}
                          </span>
                          <span className={styles['entryTrail']}>
                            <span
                              className={
                                c.type === 'remote'
                                  ? `${styles['entryKind']} ${styles['entryKindRemote']}`
                                  : styles['entryKind']
                              }
                            >
                              {c.type}
                            </span>
                            <span className={flagged > 0 ? styles['flagged'] : styles['flaggedZero']}>
                              {flagged > 0 ? `${flagged} flagged` : '0'}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
            ) : (
              <p className={styles['noMatch']}>No connectors match.</p>
            )}
          </div>

          <div className={styles['inspector']}>
            {selectedConnector !== null ? (
              <ConnectorInspector
                key={selectedConnector.name}
                connector={selectedConnector}
                authAlert={authAlerts.find((a) => a.mcp === selectedConnector.name) ?? null}
                onOpenInDetections={onOpenInDetections}
                onAudit={onAudit}
                onReconnect={onReconnect}
                onRemove={onRemove}
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
          {/* One empty state for both cases; only step 1 adapts to whether a
              Claude Desktop config exists yet. */}
          <h2 className={styles['emptyHeading']}>Start auditing your connectors</h2>
          <p className={styles['emptyDetail']}>
            Right now Claude talks to your tools directly. Route that traffic through
            xCLAUDE in three steps:
          </p>
          {/* Step lead-ins double as the step's action, AND a standalone
              "+ Add connector" follows the checklist — deliberate coexistence:
              the step-2 link is the action in the checklist's context, the
              button is the screen's primary, always-visible CTA. */}
          <ol className={styles['emptySteps']}>
            <li>
              <button type="button" className={styles['emptyStepLink']} onClick={onOpenSettings}>
                Install
              </button>
              {configPresent ? (
                <>
                  {' '}— wraps the local MCP servers already in your Claude Desktop config.
                </>
              ) : (
                <>
                  {' '}— open Claude Desktop and add at least one MCP server first, then
                  Install wraps your config so traffic flows through xCLAUDE.
                </>
              )}
            </li>
            <li>
              <button
                type="button"
                className={styles['emptyStepLink']}
                onClick={() => setAddOpen(true)}
                aria-haspopup="dialog"
              >
                Add your connectors here
              </button>
              {' '}— reconnect the remote services you use through xCLAUDE instead of
              natively. Google services need a one-time setup — the Set up button walks you
              through it.
            </li>
            <li>
              <b>Disconnect the native versions</b> in Claude Desktop and restart it —
              otherwise those calls bypass the audit.
            </li>
          </ol>
          <p className={styles['emptyHint']}>
            Local MCP servers from your Claude config appear here after Install.
          </p>
          <button
            type="button"
            className={styles['addButton']}
            onClick={() => setAddOpen(true)}
            aria-haspopup="dialog"
          >
            + Add connector
          </button>
        </div>
      )}

      <SelfTest />

      <AddConnectorModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onRefresh={onRefresh}
      />
    </div>
  );
}
