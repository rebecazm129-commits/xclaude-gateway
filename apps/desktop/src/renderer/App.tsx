import { useCallback, useEffect, useState } from 'react';

import type { StatusResult } from '@xcg/shared/config';

import { Detections } from './components/Detections.js';
import { Setup } from './components/Setup.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { HealthWarning } from './components/HealthWarning.js';
import { Tabs, type TabOption } from './components/Tabs.js';
import { usePolledHealth } from './hooks/usePolledHealth.js';

import styles from './App.module.css';

type TabId = 'setup' | 'detections';

const TAB_OPTIONS: readonly TabOption<TabId>[] = [
  { id: 'setup', label: 'Connectors' },
  { id: 'detections', label: 'Detections' },
];

const LAST_TAB_STORAGE_KEY = 'xcg:lastTab';

function readLastTab(): TabId | null {
  try {
    const stored = window.localStorage.getItem(LAST_TAB_STORAGE_KEY);
    if (stored === 'setup' || stored === 'detections') {
      return stored;
    }
    return null;
  } catch {
    // localStorage may be unavailable (private mode, etc.). Fail open.
    return null;
  }
}

function writeLastTab(tab: TabId): void {
  try {
    window.localStorage.setItem(LAST_TAB_STORAGE_KEY, tab);
  } catch {
    // Best-effort — if write fails the app still works, just no persistence.
  }
}

// Decide which tab to show on first launch when localStorage is empty.
// Setup is the default if there's nothing wrapped yet (the user hasn't completed
// setup, or there's no config at all). Detections is the default once at least
// one MCP is wrapped.
function defaultTabFromStatus(status: StatusResult | null): TabId {
  if (status === null) return 'setup';
  if (!status.ok) return 'setup';
  if (!status.configPresent) return 'setup';
  if (status.summary.alreadyWrapped === 0) return 'setup';
  return 'detections';
}

export function App(): JSX.Element {
  const [configStatus, setConfigStatus] = useState<StatusResult | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(() => readLastTab() ?? 'setup');
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { health, refresh: refreshHealth } = usePolledHealth();

  const pulseVariantClass =
    health === null
      ? styles['pulseUnknown']
      : health.status === 'healthy'
        ? styles['pulseHealthy']
        : styles['pulseUnhealthy'];

  const pulseTooltip =
    health === null
      ? 'Checking system health…'
      : health.checks
          .map((c) => {
            const label = c.check === 'symlink' ? 'Stable launcher' : c.check === 'config' ? 'Config file' : 'Wrap paths';
            if (c.status === 'ok') return `✓ ${label}`;
            if (c.status === 'skip') return `– ${label}: ${c.reason}`;
            return `✗ ${label}: ${c.reason}`;
          })
          .join('\n');

  async function handleRefresh(): Promise<void> {
    await refreshHealth();
    // Also refresh configStatus per C4-D-12: repair touches the config, both views need sync.
    try {
      const status = await window.xcg.configStatus();
      setConfigStatus(status);
    } catch (err) {
      console.error('configStatus refresh failed:', err);
    }
  }

  function handleRepaired(_result: import('@xcg/shared').RepairResult): void {
    void handleRefresh();
  }

  // One-shot configStatus on mount (D-D4). Sets the initial status and, if
  // localStorage was empty, picks the default tab based on the result.
  useEffect(() => {
    let cancelled = false;
    void window.xcg.configStatus().then((result) => {
      if (cancelled) return;
      setConfigStatus(result);
      // Only override the tab if localStorage had no preference.
      if (readLastTab() === null) {
        setActiveTab(defaultTabFromStatus(result));
      }
      setStatusLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    writeLastTab(tab);
  }, []);

  const refreshStatus = useCallback(() => {
    void window.xcg.configStatus().then((result) => {
      setConfigStatus(result);
    });
  }, []);

  return (
    <div className={styles['app']}>
      <header className={styles['header']}>
        <span className={styles['titleGroup']}>
          <span className={styles['titleRow']}>
            <span
              className={`${styles['pulse']} ${pulseVariantClass}`}
              title={pulseTooltip}
              aria-label={`System health: ${health?.status ?? 'unknown'}`}
            />
            <h1 className={styles['title']}>xCLAUDE Gateway</h1>
          </span>
          <span className={styles['trust']}>Audited locally · No account</span>
        </span>
        <div className={styles['headerActions']}>
          <button
            type="button"
            className={styles['refreshButton']}
            onClick={() => void handleRefresh()}
            title="Refresh status"
            aria-label="Refresh status"
          >
            ⟳
          </button>
          <button
            type="button"
            className={styles['refreshButton']}
            onClick={() => setSettingsOpen(true)}
            title="Open settings"
            aria-label="Open settings"
          >
            ⚙
          </button>
        </div>
      </header>
      <Tabs options={TAB_OPTIONS} active={activeTab} onChange={handleTabChange} />
      <HealthWarning health={health} onRepaired={handleRepaired} />
      {activeTab === 'setup' ? (
        <Setup status={statusLoaded ? configStatus : null} onRefresh={refreshStatus} />
      ) : (
        <Detections />
      )}
      {settingsOpen && (
        <SettingsDrawer
          status={statusLoaded ? configStatus : null}
          onRefresh={refreshStatus}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
