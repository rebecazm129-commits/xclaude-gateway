import { useEffect, useState, type ReactElement } from 'react';

import type { Connector } from '@xcg/shared/config/connectors';
import type { ConnectResult, RemoveRemoteResult } from '@xcg/shared/config';

import type { DetectionEvent, ToolCount, ConnectorAuthAlert } from '../../shared/types.js';
import { usePolledDetections } from '../hooks/usePolledDetections.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, formatTimestamp } from './detections-format.js';
import { connectMessage, errorMessage } from './config-messages.js';
import type { BaselineHistoryEntry } from '../lib/xcgApi.js';

import styles from './ConnectorInspector.module.css';
import { countsAsFlagged } from '../../shared/flagged.js';

// The auditor's own lifecycle, phrased as what it did — not as a verdict on
// the connector. `migrated` deliberately says "now also tracking", never
// "these did not change": nothing ever looked at those fields before.
function baselineLine(e: BaselineHistoryEntry): string {
  switch (e.event) {
    case 'section_initialized':
      return `Started tracking ${e.section ?? 'a section'}`;
    case 'migrated':
      return `Baseline upgraded — now also tracking ${e.coverageExpanded?.length ?? 0} more fields`;
    case 'projection_migrated':
      return `Risk view recalculated (v${e.fromVersion ?? '?'} → v${e.toVersion ?? '?'})`;
    case 'reseeded':
      return e.reason === 'corrupt'
        ? `Baseline could not be read and was rebuilt${e.section ? ` (${e.section})` : ''}`
        : `Baseline created${e.section ? ` (${e.section})` : ''}`;
    case 'snapshot_incomplete':
      return `Could not read the full ${e.section ?? 'section'} list`;
  }
}

function isBaselineWarning(e: BaselineHistoryEntry): boolean {
  return e.event === 'snapshot_incomplete' || (e.event === 'reseeded' && e.reason === 'corrupt');
}

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

// Version source: informational, not a detection — no icon, no severity
// colour. The value is the fact; the note under a mutable one says why it
// matters and what would pin it.
function launchNote(launch: NonNullable<Connector['launch']>): string {
  return launch.launcher === 'docker'
    ? 'This tag can point to a different image over time. Pin a digest for reproducible launches.'
    : 'This reference can resolve to a different version on a future launch. Pin a version for reproducible launches.';
}

interface ConnectorInspectorProps {
  connector: Connector;
  authAlert: ConnectorAuthAlert | null;
  onOpenInDetections: (name: string) => void;
  onAudit: (name: string) => void;
  onReconnect: (name: string, url: string) => Promise<ConnectResult>;
  onRemove: (name: string) => Promise<RemoveRemoteResult>;
}

export function ConnectorInspector({ connector, authAlert, onOpenInDetections, onAudit, onReconnect, onRemove }: ConnectorInspectorProps): ReactElement {
  const detections = usePolledDetections();
  const [busy, setBusy] = useState(false);
  const [reconnectResult, setReconnectResult] = useState<ConnectResult | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeResult, setRemoveResult] = useState<RemoveRemoteResult | null>(null);
  // null = loading/unknown ("—"); true/false = token present/absent. Remote only.
  const [authPresent, setAuthPresent] = useState<boolean | null>(null);
  // null = loading/none/error ("—"); otherwise the latest tool inventory size.
  const [toolCount, setToolCount] = useState<ToolCount | null>(null);
  // Card detail, fetched on demand. Deliberately NOT part of the polled audit:
  // keeping it off that path is what guarantees it can never reach a counter.
  const [baseline, setBaseline] = useState<BaselineHistoryEntry[]>([]);
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const calls7d = detections.filter(
    (e): e is DetectionEvent =>
      e.type === 'mcp.request' &&
      e.mcp === connector.name &&
      new Date(e.ts).getTime() >= weekAgoMs,
  );
  const flagged7d = calls7d.filter(
    (e) => countsAsFlagged(e.detection.category),
  );
  const recentFlagged = flagged7d.slice(0, 8);

  // Reconnect is only offered for remote bridges of ours (type 'remote' with a
  // known endpoint URL). Re-runs the OAuth login and rewrites the entry; the
  // result banner reuses connectMessage (distinguishes "Reconnected" copy).
  const canReconnect = connector.type === 'remote' && connector.endpoint !== null;

  // Query the Keychain once on mount. No polling: the inspector is keyed by
  // connector name, so selecting another connector remounts and re-runs this.
  useEffect(() => {
    let cancelled = false;
    // Optional-called on purpose: the renderer must not assume the preload
    // exposes every method. A renderer running against an older preload gets
    // an empty history instead of a crashed card.
    const load = window.xcg.baselineHistory?.(connector.name);
    if (load === undefined) {
      setBaseline([]);
      return undefined;
    }
    void load
      .then((h) => {
        if (!cancelled) setBaseline(h);
      })
      .catch(() => {
        if (!cancelled) setBaseline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connector.name]);

  useEffect(() => {
    if (connector.type !== 'remote') return;
    let cancelled = false;
    setAuthPresent(null);
    void window.xcg.configHasCredentials(connector.name).then(
      (present) => {
        if (!cancelled) setAuthPresent(present);
      },
      (err) => {
        if (!cancelled) {
          console.error('auth check failed:', err);
          setAuthPresent(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connector.type, connector.name]);

  // Tool count for every connector type, read once on mount (keyed remount per
  // connector → no polling). Same shape as the Auth query.
  useEffect(() => {
    let cancelled = false;
    setToolCount(null);
    void window.xcg.configToolCount(connector.name).then(
      (tc) => {
        if (!cancelled) setToolCount(tc);
      },
      (err) => {
        if (!cancelled) {
          console.error('tool count failed:', err);
          setToolCount(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connector.name]);

  async function handleReconnect(): Promise<void> {
    if (busy || removing || connector.endpoint === null) return;
    setBusy(true);
    setReconnectResult(null);
    setRemoveResult(null);
    setConfirmingRemove(false);
    try {
      const result = await onReconnect(connector.name, connector.endpoint);
      setReconnectResult(result);
      // A successful reconnect re-authorized the token, so it exists now; keep
      // the Auth row fresh without waiting for a remount.
      if (result.ok) setAuthPresent(true);
    } catch (err) {
      // configConnect IPC essentially never rejects (the handler returns a
      // result); log defensively rather than surface a half-state.
      console.error('reconnect failed:', err);
    } finally {
      setBusy(false);
    }
  }

  // Remove is a two-click inline confirm. The first click only flips to the
  // confirm state (no IPC); "Confirm remove" runs it, "Cancel" backs out.
  // Switching selection resets all of this (the inspector is keyed by name).
  function handleRemoveClick(): void {
    if (busy || removing) return;
    setReconnectResult(null);
    setRemoveResult(null);
    setConfirmingRemove(true);
  }

  function handleCancelRemove(): void {
    setConfirmingRemove(false);
  }

  async function handleConfirmRemove(): Promise<void> {
    if (busy || removing) return;
    setRemoving(true);
    setRemoveResult(null);
    try {
      const result = await onRemove(connector.name);
      setRemoveResult(result);
      // ok+wrote: the parent re-reads the config, the entry vanishes from the
      // list and this inspector unmounts. noop/error: stay, exit confirm, banner.
      if (!(result.ok && result.outcome === 'wrote')) {
        setConfirmingRemove(false);
      }
    } catch (err) {
      console.error('remove failed:', err);
      setConfirmingRemove(false);
    } finally {
      setRemoving(false);
    }
  }

  const message = reconnectResult !== null ? connectMessage(reconnectResult) : null;

  // ok+wrote → no banner (the entry disappears). ok+noop → soft error: the entry
  // exists but isn't ours to remove. !ok → reuse the shared errorMessage mapping.
  const removeBanner =
    removeResult === null
      ? null
      : removeResult.ok
        ? removeResult.outcome === 'noop'
          ? "This connector isn’t managed by xCLAUDE, so it can’t be removed here. Remove it from claude_desktop_config.json manually."
          : null
        : errorMessage(removeResult.error);

  return (
    <div className={styles['root']}>
      <div className={styles['head']}>
        <span className={styles['headName']}>{connector.name}</span>
        <span
          className={
            connector.type === 'remote'
              ? `${styles['headType']} ${styles['headTypeRemote']}`
              : styles['headType']
          }
        >
          {TYPE_LABEL[connector.type]}
        </span>
        <span className={styles['headStatus']}>
          {authAlert !== null ? (
            <>
              <span className={`${styles['dot']} ${styles['dotWarn']}`} />
              Needs re-login
            </>
          ) : (
            <>
              <span className={`${styles['dot']} ${STATUS_DOT[connector.status]}`} />
              {STATUS_LABEL[connector.status]}
            </>
          )}
        </span>
        {connector.status === 'not-audited' ? (
          <button
            type="button"
            className={styles['auditButton']}
            onClick={() => onAudit(connector.name)}
          >
            Audit
          </button>
        ) : null}
      </div>

      {authAlert !== null ? (
        <div className={styles['authStrip']}>
          <span className={styles['authStripIcon']} aria-hidden="true">{'⚠︎'}</span>
          <div>
            <div className={styles['authStripTitle']}>Authorization expired</div>
            <div className={styles['authStripBody']}>
              Reconnect to resume auditing, then restart Claude Desktop.
            </div>
          </div>
        </div>
      ) : null}

      {baseline.filter(isBaselineWarning).slice(0, 2).map((e) => (
        <div key={`${e.ts}-${e.event}`} className={styles['authStrip']} data-testid="baseline-warning">
          <span className={styles['authStripIcon']} aria-hidden="true">{'⚠︎'}</span>
          <div>
            <div className={styles['authStripTitle']}>{baselineLine(e)}</div>
            <div className={styles['authStripBody']}>
              {e.event === 'snapshot_incomplete'
                ? 'The baseline was left untouched — a partial list would look like a change that never happened.'
                : 'Something modified or damaged the auditor’s own stored baseline.'}
            </div>
          </div>
        </div>
      ))}

      <dl className={styles['rows']}>
        <div className={styles['row']}>
          <dt className={styles['label']}>Transport</dt>
          <dd className={styles['value']}>{TRANSPORT_LABEL[connector.type]}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Endpoint</dt>
          <dd className={styles['value']}>{connector.endpoint ?? '—'}</dd>
        </div>
        {connector.launch !== undefined ? (
          <div className={styles['row']} data-testid="launch-reference">
            <dt className={styles['label']}>Version source</dt>
            <dd className={styles['value']}>
              {connector.launch.mutable ? 'Mutable' : `Pinned to ${connector.launch.pinned ?? ''}`}
              {connector.launch.mutable ? (
                <p className={styles['valueNote']}>{launchNote(connector.launch)}</p>
              ) : null}
            </dd>
          </div>
        ) : null}
        {connector.type === 'remote' ? (
          <div className={styles['row']}>
            <dt className={styles['label']}>Auth</dt>
            <dd className={styles['value']}>
              {authPresent === null
                ? '—'
                : authPresent
                  ? 'OAuth · token stored in Keychain'
                  : 'OAuth · no token stored'}
            </dd>
          </div>
        ) : null}
        <div className={styles['row']}>
          <dt className={styles['label']}>Tools</dt>
          <dd className={styles['value']}>{toolCount !== null ? toolCount.count : '—'}</dd>
        </div>
        <div className={styles['row']}>
          <dt className={styles['label']}>Calls (7d)</dt>
          <dd className={styles['value']}>{calls7d.length} audited · {flagged7d.length} flagged</dd>
        </div>
      </dl>

      <div className={styles['flagged']}>
        <div className={styles['flaggedHead']}>
          <h3 className={styles['flaggedTitle']}>Recent flagged calls</h3>
          <button
            type="button"
            className={styles['openInDetections']}
            onClick={() => onOpenInDetections(connector.name)}
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

      {baseline.length > 0 ? (
        <div className={styles['flagged']} data-testid="baseline-history">
          <div className={styles['flaggedHead']}>
            <h3 className={styles['flaggedTitle']}>Baseline history</h3>
          </div>
          <ul className={styles['baselineList']}>
            {baseline.slice(0, 8).map((e) => (
              <li key={`${e.ts}-${e.event}-${e.section ?? ''}`} className={styles['baselineItem']}>
                <span className={styles['baselineTs']}>{formatTimestamp(e.ts)}</span>
                <span className={styles['baselineText']}>{baselineLine(e)}</span>
              </li>
            ))}
          </ul>
          <p className={styles['baselineNote']}>
            What the auditor tracked and repaired. These are not detections and are not counted.
          </p>
        </div>
      ) : null}

      {canReconnect ? (
        <div className={styles['foot']}>
          <button
            type="button"
            className={authAlert !== null
              ? `${styles['reconnectButton']} ${styles['reconnectButtonPrimary']}`
              : styles['reconnectButton']}
            onClick={() => void handleReconnect()}
            disabled={busy || removing}
          >
            {busy ? 'Reconnecting… (check your browser)' : 'Reconnect'}
          </button>

          {confirmingRemove ? (
            <>
              <button
                type="button"
                className={styles['removeConfirmButton']}
                onClick={() => void handleConfirmRemove()}
                disabled={busy || removing}
              >
                {removing ? 'Removing…' : 'Confirm remove'}
              </button>
              <button
                type="button"
                className={styles['cancelButton']}
                onClick={handleCancelRemove}
                disabled={removing}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles['removeButton']}
              onClick={handleRemoveClick}
              disabled={busy || removing}
            >
              Remove
            </button>
          )}
        </div>
      ) : null}

      {message !== null ? (
        <div className={styles[`banner_${message.tone}`]}>{message.text}</div>
      ) : null}

      {removeBanner !== null ? (
        <div className={styles['banner_error']}>{removeBanner}</div>
      ) : null}
    </div>
  );
}
