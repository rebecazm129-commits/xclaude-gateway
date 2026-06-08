import { useEffect, useRef, useState } from 'react';

import type {
  InstallResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';

import { errorMessage } from './config-messages.js';

import styles from './SettingsDrawer.module.css';

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

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

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
      </div>
    </div>
  );
}
