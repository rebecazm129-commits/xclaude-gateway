// Inspector for the Claude Code source (F1.3c). Sibling of ConnectorInspector,
// deliberately NOT a variant of it: no OAuth, no endpoint, no tools inventory —
// forcing the Connector shape here would drag Keychain/Reconnect machinery into
// a source that has neither. Install/Uninstall buttons are F1.3d.

import { useState, type ReactElement } from 'react';

import type { CchookStatus, DetectionEvent, EnrichableEvent } from '../../shared/types.js';
import { normalizeSource } from '../../shared/types.js';
import { usePolledDetections } from '../hooks/usePolledDetections.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, formatTimestamp } from './detections-format.js';

import styles from './ClaudeCodeInspector.module.css';

// Axis duality (F1.5): connectors count by WIRE (e.mcp — every event a wrapper
// observed for that server, whichever client produced it); everything Claude
// Code counts by ORIGIN (source === 'claude-code' — every hook-captured event,
// whichever server it hit). An MCP call made from Claude Code therefore shows
// up on BOTH axes, deliberately: it is real traffic for its connector and a
// real capture for Claude Code. This predicate is the single definition of
// "Claude Code flagged" — the Sources row badge, the inspector counter and the
// Recent flagged list all call it, so they cannot diverge.
export function isClaudeCodeFlagged(e: EnrichableEvent, sinceMs: number): e is DetectionEvent {
  return (
    e.type === 'mcp.request' &&
    normalizeSource(e.source) === 'claude-code' &&
    e.detection.category !== 'tool_call_allowed' &&
    new Date(e.ts).getTime() >= sinceMs
  );
}

interface ClaudeCodeInspectorProps {
  /** null while the first cchook:status poll is in flight. */
  status: CchookStatus | null;
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

export function ClaudeCodeInspector({ status, onOpenInDetections }: ClaudeCodeInspectorProps): ReactElement {
  const hookRegistered = status?.hookRegistered ?? false;

  // Counter and list from the same filter pass (same shared poll the
  // ConnectorInspector uses — no extra disk scan).
  const detections = usePolledDetections();
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const flagged7d = detections.filter((e): e is DetectionEvent => isClaudeCodeFlagged(e, weekAgoMs));
  const recentFlagged = flagged7d.slice(0, 8);

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
          <span className={styles['headStatus']}>
            <span className={`${styles['dot']} ${styles['dotAudited']}`} />
            Auditing
          </span>
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
          <dd className={styles['value']}>{flagged7d.length}</dd>
        </div>
      </dl>

      <div className={styles['flagged']}>
        <div className={styles['flaggedHead']}>
          <h3 className={styles['flaggedTitle']}>Recent flagged calls</h3>
          <button
            type="button"
            className={styles['openInDetections']}
            onClick={onOpenInDetections}
          >
            Open in Detections →
          </button>
        </div>
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
      <p className={styles['scopeNote']}>
        MCP calls captured via Claude Code also appear under their connector.
      </p>
    </div>
  );
}
