import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { ConnectResult, IsConnectedResult } from '@xcg/shared/config';

import { connectMessage } from './config-messages.js';
import { LOGO_SVGS } from './connectorLogos.js';
import { Modal } from './Modal.js';

import styles from './AddConnectorModal.module.css';

type Group = 'oneclick' | 'google' | 'comingsoon';

interface CatalogEntry {
  readonly label: string;
  readonly name: string;
  /** Key into LOGO_SVGS. */
  readonly logo: string;
  readonly description: string;
  readonly group: Group;
  /** Connect target; absent for "coming soon" entries. */
  readonly url?: string;
  /** Space-separated OAuth scopes (Google needs explicit; DCR connectors omit). */
  readonly scope?: string;
}

const CATALOG: readonly CatalogEntry[] = [
  {
    label: 'Notion', name: 'notion', logo: 'notion', group: 'oneclick',
    url: 'https://mcp.notion.com/mcp',
    description: 'Pages, databases and search — every call recorded and classified.',
  },
  {
    label: 'Linear', name: 'linear', logo: 'linear', group: 'oneclick',
    url: 'https://mcp.linear.app/mcp',
    description: 'Issues, projects and comments — every call recorded and classified.',
  },
  {
    label: 'Atlassian', name: 'atlassian', logo: 'atlassian', group: 'oneclick',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    description: 'Jira and Confluence — every call recorded and classified.',
  },
  {
    label: 'GitHub', name: 'github', logo: 'github', group: 'oneclick',
    url: 'https://api.githubcopilot.com/mcp/', scope: 'repo read:org read:user',
    description: 'Repositories, issues and pull requests — every call recorded and classified.',
  },
  {
    label: 'Stripe', name: 'stripe', logo: 'stripe', group: 'oneclick',
    url: 'https://mcp.stripe.com',
    description: 'Payments, customers and invoices — every call recorded and classified.',
  },
  {
    label: 'Apollo', name: 'apollo', logo: 'apollo', group: 'oneclick',
    url: 'https://mcp.apollo.io/mcp',
    description: 'Prospecting, contacts and enrichment — every call recorded and classified.',
  },
  {
    label: 'Slack', name: 'slack', logo: 'slack', group: 'oneclick',
    url: 'https://mcp.slack.com/mcp',
    description: 'Search, messages and canvases — every call recorded and classified.',
  },
  {
    label: 'Gmail', name: 'gmail', logo: 'gmail', group: 'google',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    description: "Read and draft — Google's MCP has no send tool by design.",
  },
  {
    label: 'Google Calendar', name: 'calendar', logo: 'googlecalendar', group: 'google',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    scope:
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly',
    description: 'Read-only calendar access — every call recorded and classified.',
  },
  {
    label: 'Google Drive', name: 'drive', logo: 'googledrive', group: 'google',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
    description: 'Read and per-file access — every call recorded and classified.',
  },
  {
    label: 'Asana', name: 'asana', logo: 'asana', group: 'comingsoon',
    description: 'Tasks and projects.',
  },
  {
    label: 'HubSpot', name: 'hubspot', logo: 'hubspot', group: 'comingsoon',
    description: 'CRM, contacts and deals.',
  },
];

const GROUPS: readonly { id: Group; label: string; note?: ReactNode }[] = [
  { id: 'oneclick', label: 'One-click connect' },
  {
    id: 'google',
    label: 'Google services',
    note: (
      <>
        <b>One-time setup:</b> Google requires your own (free) OAuth client. One client serves
        Gmail, Calendar and Drive — see the README for the steps.
      </>
    ),
  },
  { id: 'comingsoon', label: 'Coming soon' },
];

// TODO: final destination is GitHub Issues once the repo is public.
const REQUEST_URL = 'https://xclaude.ai';

const FOOT_NOTE =
  "Your authorization token is stored in the macOS Keychain. xCLAUDE observes the traffic on its way through — it doesn't reroute or withhold it.";

export interface AddConnectorModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a successful connect (config changed) so the parent re-reads it. */
  readonly onRefresh?: () => void;
}

/**
 * "Add connector" modal — the gallery of predefined remote connectors. Add-only:
 * already-configured entries show "Added" (Reconnect lives in the inspector). A
 * connect runs the interactive login (the browser opens; it can take minutes),
 * then writes the bridge entry. Kept mounted by Setup (visibility via `open`) so
 * an in-flight "Connecting…" survives a close/reopen; a mountedRef guards
 * setState after unmount.
 */
export function AddConnectorModal({ open, onClose, onRefresh }: AddConnectorModalProps): ReactElement | null {
  const [busyName, setBusyName] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectedNames, setConnectedNames] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Which catalog connectors are already configured. Runs once on mount; the set
  // is also updated optimistically after a successful connect.
  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      const found = new Set<string>();
      for (const entry of CATALOG) {
        if (entry.url === undefined) continue; // coming soon: nothing to query
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
    if (entry.url === undefined || busyName !== null) return;
    setBusyName(entry.name);
    setLastResult(null);
    setError(null);
    try {
      const result = await window.xcg.configConnect(entry.name, entry.url, entry.scope);
      if (!mountedRef.current) return;
      setLastResult(result);
      if (result.ok) {
        setConnectedNames((prev) => new Set(prev).add(entry.name));
        onRefresh?.();
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      if (mountedRef.current) setBusyName(null);
    }
  }

  // Mounted whenever Setup is, so in-flight state survives close/reopen; render
  // the modal UI only while open.
  if (!open) return null;

  const q = query.trim().toLowerCase();
  const matches = (e: CatalogEntry): boolean => e.label.toLowerCase().includes(q);
  const anyMatch = CATALOG.some(matches);
  const message = lastResult !== null ? connectMessage(lastResult) : null;

  function actionButton(entry: CatalogEntry): ReactElement {
    if (entry.group === 'comingsoon') {
      return <button type="button" className={styles['btnGhost']} disabled>Coming soon</button>;
    }
    if (connectedNames.has(entry.name)) {
      return <button type="button" className={styles['btnGhost']} disabled>Added</button>;
    }
    if (busyName === entry.name) {
      return (
        <button type="button" className={styles['btnConnecting']} disabled>
          Connecting… authorize in your browser
        </button>
      );
    }
    return (
      <button
        type="button"
        className={styles['btnConnect']}
        onClick={() => void handleConnect(entry)}
        disabled={busyName !== null}
      >
        Connect
      </button>
    );
  }

  return (
    <Modal title="Add connector" onClose={onClose} footer={FOOT_NOTE}>
      <p className={styles['sub']}>
        Connect a remote service through xCLAUDE to audit every call Claude makes to it. A browser
        window opens to authorize.
      </p>

      <div className={styles['searchWrap']}>
        <input
          type="search"
          className={styles['search']}
          placeholder="Search connectors…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search connectors"
        />
      </div>

      <div className={styles['gallery']}>
        {!anyMatch ? (
          <p className={styles['noMatch']}>No connectors match “{query}”.</p>
        ) : (
          GROUPS.map((group) => {
            const cards = CATALOG.filter((e) => e.group === group.id && matches(e));
            if (cards.length === 0) return null;
            return (
              <div key={group.id}>
                <div className={styles['groupLabel']}>{group.label}</div>
                {group.note != null ? <div className={styles['groupNote']}>{group.note}</div> : null}
                <div className={styles['cardGrid']}>
                  {cards.map((entry) => (
                    <div
                      key={entry.name}
                      data-testid={`connector-card-${entry.name}`}
                      className={
                        entry.group === 'comingsoon'
                          ? `${styles['card']} ${styles['cardComingSoon']}`
                          : styles['card']
                      }
                    >
                      <div className={styles['cardTop']}>
                        <span className={styles['logoTile']}>
                          <span
                            className={styles['logoGlyph']}
                            // Trusted, static, build-time-vendored SVG (no user input).
                            dangerouslySetInnerHTML={{ __html: LOGO_SVGS[entry.logo] ?? '' }}
                          />
                        </span>
                        <span className={styles['cardName']}>{entry.label}</span>
                      </div>
                      <div className={styles['cardDesc']}>{entry.description}</div>
                      <div className={styles['cardAction']}>{actionButton(entry)}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}

        <p className={styles['requestLink']}>
          <button
            type="button"
            className={styles['requestLinkButton']}
            onClick={() => void window.xcg.openExternalUrl(REQUEST_URL)}
          >
            Request a connector →
          </button>
        </p>
      </div>

      {error !== null ? (
        <div className={styles['banners']}>
          <div className={styles['banner_error']}>Connection failed: {error}</div>
        </div>
      ) : message !== null ? (
        <div className={styles['banners']}>
          <div className={styles[`banner_${message.tone}`]}>{message.text}</div>
        </div>
      ) : null}
    </Modal>
  );
}
