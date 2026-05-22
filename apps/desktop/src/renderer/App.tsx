import { useCallback, useEffect, useState } from 'react';

import type { StatusResult } from '@xcg/shared/config';

import { Detections } from './components/Detections.js';
import { Setup } from './components/Setup.js';
import { Tabs, type TabOption } from './components/Tabs.js';

import styles from './App.module.css';

type TabId = 'setup' | 'detections';

const TAB_OPTIONS: readonly TabOption<TabId>[] = [
  { id: 'setup', label: 'Setup' },
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
          <span className={styles['pulse']} aria-hidden="true" />
          <h1 className={styles['title']}>xCLAUDE Gateway</h1>
        </span>
      </header>
      <Tabs options={TAB_OPTIONS} active={activeTab} onChange={handleTabChange} />
      {activeTab === 'setup' ? (
        <Setup status={statusLoaded ? configStatus : null} onRefresh={refreshStatus} />
      ) : (
        <Detections />
      )}
    </div>
  );
}
