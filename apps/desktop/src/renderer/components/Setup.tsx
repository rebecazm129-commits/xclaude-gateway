import { useState, type ReactElement } from 'react';

import { toConnectors, type Connector } from '@xcg/shared/config/connectors';
import type {
  InstallResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';

import { RemoteConnectors } from './RemoteConnectors.js';
import { SelfTest } from './SelfTest.js';

import styles from './Setup.module.css';

export interface SetupProps {
  readonly status: StatusResult | null;
  readonly onRefresh: () => void;
}

type ActionState = 'idle' | 'installing' | 'uninstalling';
type LastAction = InstallResult | UninstallResult | null;

const CONNECTOR_GROUPS: readonly {
  readonly status: Connector['status'];
  readonly title: string;
}[] = [
  { status: 'not-audited', title: 'Not audited' },
  { status: 'audited', title: 'Auditing' },
  { status: 'unsupported', title: 'Unsupported' },
];

// Format error.kind for the inline error panel. Detail comes through verbatim.
function errorMessage(err: { kind: string; detail?: string }): string {
  switch (err.kind) {
    case 'not-found':
      return 'claude_desktop_config.json was not found. Open Claude Desktop and add at least one MCP server first.';
    case 'invalid-json':
      return `claude_desktop_config.json is not valid JSON. ${err.detail ?? ''}`.trim();
    case 'unexpected-shape':
      return `claude_desktop_config.json has an unexpected shape. ${err.detail ?? ''}`.trim();
    case 'unreadable':
      return err.detail ?? 'Could not read claude_desktop_config.json.';
    default:
      return 'An unexpected error occurred.';
  }
}

// Format the outcome of a completed install or uninstall.
function outcomeMessage(action: LastAction): { tone: 'success' | 'noop' | 'error'; text: string } | null {
  if (action === null) return null;
  if (!action.ok) {
    return { tone: 'error', text: errorMessage(action.error) };
  }
  // ok:true — discriminate by outcome.
  if (action.outcome === 'wrote') {
    if ('xcgPath' in action) {
      // InstallOk.
      return { tone: 'success', text: `Installed. ${action.summary.wrappable} MCP wrapped.` };
    }
    return { tone: 'success', text: 'Uninstalled. xCLAUDE Gateway is no longer in your MCP chain.' };
  }
  if (action.outcome === 'noop') {
    return { tone: 'noop', text: 'No changes needed.' };
  }
  // would_write only happens in dry-run, which we do not use from the UI.
  return null;
}

export function Setup({ status, onRefresh }: SetupProps): ReactElement {
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [lastAction, setLastAction] = useState<LastAction>(null);

  async function handleInstall(): Promise<void> {
    setActionState('installing');
    setLastAction(null);
    const result = await window.xcg.configInstall('yes');
    setLastAction(result);
    setActionState('idle');
    onRefresh();
  }

  async function handleUninstall(): Promise<void> {
    setActionState('uninstalling');
    setLastAction(null);
    const result = await window.xcg.configUninstall('yes');
    setLastAction(result);
    setActionState('idle');
    onRefresh();
  }

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

  const { configPresent, configPath, entries, summary } = status;
  const connectors = toConnectors(entries);
  const canInstall = configPresent && summary.wrappable > 0 && actionState === 'idle';
  const canUninstall = configPresent && summary.alreadyWrapped > 0 && actionState === 'idle';
  const action = outcomeMessage(lastAction);

  return (
    <div className={styles['container']}>
      <div className={styles['intro']}>
        <p className={styles['path']}>
          <span className={styles['pathLabel']}>Config file:</span>{' '}
          <code className={styles['pathValue']}>{configPath}</code>
        </p>
        {!configPresent ? (
          <p className={styles['notice']}>
            Claude Desktop has no MCP config yet. Open Claude Desktop, add at least
            one MCP server, then come back here to install xCLAUDE Gateway.
          </p>
        ) : null}
      </div>

      {configPresent ? (
        <>
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
                      <li key={c.name} className={styles['entry']}>
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

          <div className={styles['introBlock']}>
            <p className={styles['introHeading']}>See what Claude does.</p>
            <p className={styles['introDetail']}>Every tool call Claude makes, classified by risk. 6 categories, 4 severity levels.</p>
            <p className={styles['introTag']}>Audited locally. No account.</p>
          </div>

          <div className={styles['actions']}>
            <button
              type="button"
              className={styles['installButton']}
              onClick={handleInstall}
              disabled={!canInstall}
            >
              {actionState === 'installing' ? 'Installing…' : 'Install'}
            </button>
            <button
              type="button"
              className={styles['uninstallButton']}
              onClick={handleUninstall}
              disabled={!canUninstall}
            >
              {actionState === 'uninstalling' ? 'Uninstalling…' : 'Uninstall'}
            </button>
            <button
              type="button"
              className={styles['refreshButton']}
              onClick={onRefresh}
              disabled={actionState !== 'idle'}
            >
              Refresh
            </button>
          </div>
          {canUninstall ? (
            <p className={styles['uninstallHint']}>
              Before removing xCLAUDE Gateway from your Applications folder, click Uninstall to restore your MCP configuration.
            </p>
          ) : null}
        </>
      ) : (
        <div className={styles['actions']}>
          <button
            type="button"
            className={styles['refreshButton']}
            onClick={onRefresh}
          >
            Refresh
          </button>
        </div>
      )}

      {action !== null ? (
        <div className={styles[`feedback_${action.tone}`]}>{action.text}</div>
      ) : null}

      <RemoteConnectors onRefresh={onRefresh} />

      <SelfTest />
    </div>
  );
}
