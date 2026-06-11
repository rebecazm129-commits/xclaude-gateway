import { useState, useEffect, type ReactElement } from 'react';

import type { ConnectResult, IsConnectedResult } from '@xcg/shared/config';

import { connectMessage } from './config-messages.js';
import styles from './RemoteConnectors.module.css';

interface CatalogEntry {
  readonly label: string;
  readonly name: string;
  readonly url: string;
  /** Space-separated OAuth scopes to request (Google/Gmail needs explicit
   *  scopes; DCR connectors omit it). */
  readonly scope?: string;
}

const CONNECTORS: readonly CatalogEntry[] = [
  { label: 'Notion', name: 'notion', url: 'https://mcp.notion.com/mcp' },
  { label: 'Linear', name: 'linear', url: 'https://mcp.linear.app/mcp' },
  { label: 'Atlassian', name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
  {
    label: 'Gmail',
    name: 'gmail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
  },
];

export interface RemoteConnectorsProps {
  /** Called after a successful connect (the config changed); optional so the
   * panel still works standalone. */
  readonly onRefresh?: () => void;
}

/**
 * "Remote connectors" panel for the Setup tab. Self-contained (like SelfTest):
 * invokes window.xcg.configConnect / configIsConnected internally. Catalog of
 * predefined connectors; this panel is add-only — already-connected entries
 * show just an "Added" badge (Reconnect lives in the connector inspector). A
 * connect runs the interactive login (it can take minutes — the browser opens),
 * then writes the bridge entry.
 */
export function RemoteConnectors({ onRefresh }: RemoteConnectorsProps): ReactElement {
  const [busyName, setBusyName] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectedNames, setConnectedNames] = useState<ReadonlySet<string>>(() => new Set());

  // On mount: query which catalog connectors are already configured. A failed
  // query (corrupt config) is swallowed — it just leaves the connector unmarked.
  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      const found = new Set<string>();
      for (const entry of CONNECTORS) {
        try {
          const res: IsConnectedResult = await window.xcg.configIsConnected(entry.name);
          if (res.ok && res.connected) found.add(entry.name);
        } catch {
          // ignore: a failed query should not break the catalog
        }
      }
      if (!cancelled) setConnectedNames(found);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConnect(entry: CatalogEntry): Promise<void> {
    if (busyName !== null) return;
    setBusyName(entry.name);
    setLastResult(null);
    setError(null);
    try {
      const result = await window.xcg.configConnect(entry.name, entry.url, entry.scope);
      setLastResult(result);
      if (result.ok) {
        setConnectedNames((prev) => {
          const next = new Set(prev);
          next.add(entry.name);
          return next;
        });
        // The connect wrote a new entry into claude_desktop_config.json; let
        // the parent re-read it so the Setup list reflects it without a manual
        // Refresh.
        onRefresh?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusyName(null);
    }
  }

  const message = lastResult !== null ? connectMessage(lastResult) : null;

  return (
    <div className={styles['container']}>
      <div className={styles['header']}>
        <div className={styles['heading']}>
          <p className={styles['title']}>Remote connectors</p>
          <p className={styles['subtitle']}>
            Connect a remote MCP server through xCLAUDE to audit every call Claude makes to it.
          </p>
        </div>
      </div>

      <ul className={styles['list']}>
        {CONNECTORS.map((entry) => (
          <li key={entry.name} className={styles['row']}>
            <span className={styles['rowLabel']}>{entry.label}</span>
            <div className={styles['rowActions']}>
              {connectedNames.has(entry.name) ? (
                <span className={styles['addedBadge']}>Added</span>
              ) : (
                <button
                  type="button"
                  className={styles['connectButton']}
                  onClick={() => void handleConnect(entry)}
                  disabled={busyName !== null}
                >
                  {busyName === entry.name ? 'Connecting… (check your browser)' : 'Connect'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {error !== null ? (
        <div className={styles['banner_error']}>Connection failed: {error}</div>
      ) : null}

      {message !== null ? (
        <div className={styles[`banner_${message.tone}`]}>{message.text}</div>
      ) : null}
    </div>
  );
}
