// Inspector for the Claude Code source (F1.3c). Sibling of ConnectorInspector,
// deliberately NOT a variant of it: no OAuth, no endpoint, no tools inventory —
// forcing the Connector shape here would drag Keychain/Reconnect machinery into
// a source that has neither. Install/Uninstall buttons are F1.3d.

import { useState, type ReactElement } from 'react';

import type { CchookStatus } from '../../shared/types.js';

import styles from './ClaudeCodeInspector.module.css';

interface ClaudeCodeInspectorProps {
  /** null while the first cchook:status poll is in flight. */
  status: CchookStatus | null;
  /** Flagged mcp.request count over the last 7d for mcp 'claude-code'
   *  (aggregated once in Setup, same map the connector rows use). */
  flagged7d: number;
  /** Opens Detections with sources preset to ['claude-code']. */
  onOpenInDetections: () => void;
}

// Compact relative time for the heartbeat row. Coarse on purpose: the value
// answers "is Claude Code alive-ish", not "when exactly".
export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const deltaMs = nowMs - t;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ClaudeCodeInspector({ status, flagged7d, onOpenInDetections }: ClaudeCodeInspectorProps): ReactElement {
  const hookRegistered = status?.hookRegistered ?? false;

  // Uninstall mirrors ConnectorInspector's Remove: two-step confirmation,
  // busy state, error banner. It calls window.xcg directly (same mixed
  // pattern ConnectorInspector already uses for configHasCredentials); on
  // success nothing else happens here — the 2s cchook:status poll makes the
  // section disappear and Setup resets the selection.
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  async function handleConfirmUninstall(): Promise<void> {
    setUninstalling(true);
    setUninstallError(null);
    try {
      const result = await window.xcg.cchookUninstall();
      if (!result.ok) setUninstallError(result.error);
    } catch (err) {
      setUninstallError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setUninstalling(false);
      setConfirmingUninstall(false);
    }
  }

  return (
    <div className={styles['root']}>
      <div className={styles['head']}>
        <span className={styles['headName']}>claude-code</span>
        {hookRegistered ? (
          <span className={styles['activeChip']}>Auditing active</span>
        ) : null}
      </div>

      <dl className={styles['rows']}>
        <div className={styles['row']}>
          <dt className={styles['label']}>Hook</dt>
          <dd className={styles['value']}>
            {hookRegistered ? 'registered · ~/.claude/settings.json' : '—'}
          </dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Last session heartbeat</dt>
          <dd className={styles['value']}>
            {status?.lastSessionStartTs != null ? formatRelative(status.lastSessionStartTs) : '—'}
          </dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Captures pending / unreadable</dt>
          <dd className={styles['value']}>
            {status !== null ? `${status.pendingSpool} / ${status.unreadableTotal}` : '—'}
          </dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Flagged (7d)</dt>
          <dd className={styles['value']}>{flagged7d}</dd>
        </div>
      </dl>

      <button type="button" className={styles['openInDetections']} onClick={onOpenInDetections}>
        Open in Detections
      </button>

      {hookRegistered ? (
        <div className={styles['foot']}>
          {confirmingUninstall ? (
            <>
              <button
                type="button"
                className={styles['uninstallConfirmButton']}
                onClick={() => void handleConfirmUninstall()}
                disabled={uninstalling}
              >
                {uninstalling ? 'Uninstalling…' : 'Confirm uninstall'}
              </button>
              <button
                type="button"
                className={styles['cancelButton']}
                onClick={() => setConfirmingUninstall(false)}
                disabled={uninstalling}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles['uninstallButton']}
              onClick={() => {
                setUninstallError(null);
                setConfirmingUninstall(true);
              }}
              disabled={uninstalling}
            >
              Uninstall hook
            </button>
          )}
        </div>
      ) : null}

      {uninstallError !== null ? (
        <div className={styles['banner_error']}>{uninstallError}</div>
      ) : null}

      <p className={styles['scopeNote']}>
        Audits tool calls as consumed by the model · doesn't see raw MCP wire · no
        manifest monitoring
      </p>
    </div>
  );
}
