import { useEffect, useRef, useState } from 'react';

import type {
  InstallResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';
import type { PurgeMode, RetentionStatus } from '../../shared/types.js';

import { errorMessage } from './config-messages.js';

import styles from './SettingsDrawer.module.css';

// Human-readable byte size (1024-based) for the retention size line.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val >= 10 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const PURGE_MODE_LABELS: Record<PurgeMode, string> = {
  never: 'Never — keep everything',
  '30d': 'Remove sessions older than 30 days',
  '90d': 'Remove sessions older than 90 days',
  '365d': 'Remove sessions older than 365 days',
};

interface SettingsDrawerProps {
  status: StatusResult | null;
  onRefresh: () => void;
  onClose: () => void;
}

type ActionState = 'idle' | 'installing' | 'uninstalling';
type LastAction = InstallResult | UninstallResult | null;

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

export function SettingsDrawer({ status, onRefresh, onClose }: SettingsDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [pendingMode, setPendingMode] = useState<PurgeMode | null>(null);
  const [applying, setApplying] = useState(false);
  const [retentionNotice, setRetentionNotice] = useState<string | null>(null);

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  // Retention status is fetched once when the drawer opens (not on any poll).
  useEffect(() => {
    let cancelled = false;
    void window.xcg
      .retentionStatus()
      .then((r) => {
        if (!cancelled) setRetention(r);
      })
      .catch((err) => console.error('retentionStatus failed:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleApplyMode(): Promise<void> {
    if (pendingMode === null) return;
    setApplying(true);
    setRetentionNotice(null);
    try {
      const result = await window.xcg.retentionSetMode(pendingMode);
      if (!result.ok) {
        setRetentionNotice(
          'Could not save the retention setting. Your audit log is unchanged.',
        );
        return;
      }
      setRetention((prev) => (prev ? { ...prev, config: result.config } : prev));
      setPendingMode(null);
      if (result.config.purgeMode === 'never') {
        setRetentionNotice(
          'Automatic cleanup is off. xCLAUDE Gateway keeps every audit event.',
        );
      } else if (result.purgableEstimate > 0) {
        const n = result.purgableEstimate;
        setRetentionNotice(
          `Saved. The next daily cleanup will remove about ${n} older session ` +
            `file${n === 1 ? '' : 's'}. Nothing is deleted yet.`,
        );
      } else {
        setRetentionNotice(
          'Saved. No session files are old enough to remove yet.',
        );
      }
    } catch (err) {
      console.error('retentionSetMode failed:', err);
      setRetentionNotice(
        'Could not save the retention setting. Your audit log is unchanged.',
      );
    } finally {
      setApplying(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose]);

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

  function handleOpenAuditFolder(): void {
    void window.xcg.openAuditFolder();
  }

  const statusOk = status !== null && status.ok ? status : null;
  const canInstall =
    statusOk !== null && statusOk.configPresent && statusOk.summary.wrappable > 0 && actionState === 'idle';
  const canUninstall =
    statusOk !== null && statusOk.configPresent && statusOk.summary.alreadyWrapped > 0 && actionState === 'idle';
  const action = outcomeMessage(lastAction);

  return (
    <div
      ref={drawerRef}
      className={styles['drawer']}
      role="dialog"
      aria-labelledby="settings-title"
      tabIndex={-1}
    >
      <div className={styles['header']}>
        <h2 id="settings-title" className={styles['title']}>
          Settings
        </h2>
        <button
          className={styles['closeButton']}
          onClick={onClose}
          aria-label="Close settings"
          type="button"
        >
          ×
        </button>
      </div>

      <div className={styles['body']}>
        {statusOk !== null ? (
          <p className={styles['path']}>
            <span className={styles['pathLabel']}>Config file:</span>{' '}
            <code className={styles['pathValue']}>{statusOk.configPath}</code>
          </p>
        ) : null}

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
        </div>

        {canUninstall ? (
          <p className={styles['uninstallHint']}>
            Before removing xCLAUDE Gateway from your Applications folder, click Uninstall to restore your MCP configuration.
          </p>
        ) : null}

        {action !== null ? (
          <div className={styles[`feedback_${action.tone}`]}>{action.text}</div>
        ) : null}

        <div className={styles['sectionLabel']}>Audit log</div>
        <div className={styles['auditRow']}>
          <code className={styles['auditPath']}>~/Library/Application Support/xCLAUDE Gateway/wrappers/</code>
          <button
            type="button"
            className={styles['auditButton']}
            onClick={handleOpenAuditFolder}
          >
            Open folder
          </button>
        </div>

        <div className={styles['retentionRow']}>
          <label className={styles['retentionLabel']} htmlFor="retention-mode">
            Automatic cleanup by age
          </label>
          <select
            id="retention-mode"
            className={styles['retentionSelect']}
            value={pendingMode ?? retention?.config.purgeMode ?? 'never'}
            onChange={(e) => setPendingMode(e.target.value as PurgeMode)}
            disabled={retention === null || applying}
          >
            {(['never', '30d', '90d', '365d'] as const).map((m) => (
              <option key={m} value={m}>
                {PURGE_MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles['auditButton']}
            onClick={() => void handleApplyMode()}
            disabled={
              retention === null ||
              applying ||
              pendingMode === null ||
              pendingMode === retention.config.purgeMode
            }
          >
            {applying ? 'Saving…' : 'Apply'}
          </button>
        </div>

        {retention?.size != null && (
          <p className={styles['retentionMeta']}>
            Current audit log: {formatBytes(retention.size.totalBytes)} across{' '}
            {retention.size.fileCount} file
            {retention.size.fileCount === 1 ? '' : 's'}.
          </p>
        )}

        {retention?.lastPurge != null && (
          <p className={styles['retentionMeta']}>
            Last automatic cleanup removed {retention.lastPurge.filesPurged}{' '}
            session file{retention.lastPurge.filesPurged === 1 ? '' : 's'}{' '}
            (through {formatDate(retention.lastPurge.purgedUntilTs)}).
          </p>
        )}

        {retentionNotice !== null && (
          <div className={styles['feedback_noop']}>{retentionNotice}</div>
        )}

        <div className={styles['sectionLabel']}>About</div>
        <p className={styles['about']}>
          xCLAUDE Gateway audits every tool call Claude makes through your MCP
          connectors, classified by risk across 6 risk categories and 4 severity
          levels. Everything is audited locally — no account, no telemetry.
        </p>
        <p className={styles['about']}>
          xCLAUDE Gateway is an independent, open-source project, not affiliated
          with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude
          Desktop" are trademarks of Anthropic. Other product names and logos —
          Google, Gmail, Slack, Notion, and the like — belong to their respective
          owners and are used for identification only.
        </p>
        <p className={styles['legal']}>
          MIT License · © 2026 Rebeca Zambrano Moreno & Ignacio Lucea Artero
        </p>
      </div>
    </div>
  );
}
