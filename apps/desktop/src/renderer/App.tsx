import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectResult, RemoveRemoteResult, StatusResult } from '@xcg/shared/config';

import { Detections } from './components/Detections.js';
import { Setup } from './components/Setup.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { HealthWarning } from './components/HealthWarning.js';
import {
  ResidualCredentialsWarning,
  accumulateResidualCredentials,
} from './components/ResidualCredentialsWarning.js';
import {
  VanishedConnectorsWarning,
  appendUniqueNames,
  diffVanishedConnectors,
  pruneAgedRemoves,
} from './components/VanishedConnectorsWarning.js';
import { Tabs, type TabOption } from './components/Tabs.js';
import { usePolledHealth } from './hooks/usePolledHealth.js';
import { usePolledConfigStatus } from './hooks/usePolledConfigStatus.js';

import styles from './App.module.css';

type TabId = 'setup' | 'detections';

const TAB_OPTIONS: readonly TabOption<TabId>[] = [
  { id: 'setup', label: 'Sources' },
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
  const [activeTab, setActiveTab] = useState<TabId>(() => readLastTab() ?? 'setup');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detectionsMcpFilter, setDetectionsMcpFilter] = useState<string | null>(null);
  // Connectors whose remove left Keychain credentials behind (F1-02). Memory-
  // only, lives here because the inspector that ran the remove unmounts with
  // the removed entry; cleared by the notice's explicit Dismiss.
  const [residualCreds, setResidualCreds] = useState<readonly string[]>([]);
  const { health, refresh: refreshHealth } = usePolledHealth();
  // Polled config status (10s + manual refresh), replacing the old one-shot
  // read: out-of-band config changes (Claude Desktop rewriting mcpServers, a
  // manual edit) now reach the UI within one tick (F2-04). null until the
  // first tick resolves — Setup shows its loading state on null.
  const { status: configStatus, previous: previousStatus, refresh: refreshStatus } =
    usePolledConfigStatus();
  // Add connector modal visibility. Lives here (not in Setup, where it used
  // to) so the vanished-connectors notice can open it — and switch to the
  // Connectors tab first — from any tab. Setup consumes it as a controlled prop.
  const [addOpen, setAddOpen] = useState(false);
  // F2-04 step 2: managed connectors that disappeared from the config without
  // an in-app Remove. Memory-only, accumulated across poll diffs, cleared by
  // the notice's explicit Dismiss.
  const [vanished, setVanished] = useState<readonly string[]>([]);
  // Names removed via the in-app Remove, excluded from the vanished diff. A
  // name is added BEFORE the remove IPC call: a poll tick can land between
  // main's config write and the remove promise resolving, and the diff effect
  // must already know that disappearance is in-app (adding in .then would
  // lose that race). Rolled back when the remove did not write; aged out by
  // pruneAgedRemoves once the name leaves the `previous` snapshot.
  const inAppRemoves = useRef(new Set<string>());

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
    await refreshStatus();
  }

  function handleRepaired(_result: import('@xcg/shared').RepairResult): void {
    void handleRefresh();
  }

  // Default-tab pick (D-D4): once, when the FIRST polled status arrives and
  // localStorage had no preference. The hook owns the fetch now; this effect
  // only reacts to the first non-null result.
  const tabInitialized = useRef(false);
  useEffect(() => {
    if (configStatus === null || tabInitialized.current) return;
    tabInitialized.current = true;
    // Only override the tab if localStorage had no preference.
    if (readLastTab() === null) {
      setActiveTab(defaultTabFromStatus(configStatus));
    }
  }, [configStatus]);

  // Vanished-connectors diff (F2-04 step 2): runs once per DISTINCT snapshot
  // pair (the hook's dedupe keeps references stable otherwise). Prune runs
  // AFTER the diff; the two never collide (pruning drops names absent from
  // `previous`, the diff only reports names present in it).
  useEffect(() => {
    if (previousStatus === null || configStatus === null) return;
    const gone = diffVanishedConnectors(previousStatus, configStatus, inAppRemoves.current);
    if (gone.length > 0) {
      setVanished((prev) => appendUniqueNames(prev, gone));
    }
    pruneAgedRemoves(inAppRemoves.current, previousStatus);
  }, [configStatus, previousStatus]);

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    writeLastTab(tab);
  }, []);

  // "Re-add connectors": jump to the Connectors tab (the modal lives inside
  // Setup) and open the Add connector modal. Deliberately does NOT dismiss
  // the notice — the user decides when the situation is handled.
  const handleReAdd = useCallback(() => {
    handleTabChange('setup');
    setAddOpen(true);
  }, [handleTabChange]);

  const handleOpenInDetections = useCallback((name: string) => {
    setDetectionsMcpFilter(name);
    setActiveTab('detections');
    writeLastTab('detections');
  }, []);

  const handleAudit = useCallback((name: string) => {
    void window.xcg
      .configInstall('yes', name)
      .then(() => refreshStatus())
      .catch((err) => console.error('configInstall failed:', err));
  }, [refreshStatus]);

  const handleReconnect = useCallback(
    (name: string, url: string): Promise<ConnectResult> =>
      window.xcg.configConnect(name, url).then((result) => {
        // A successful reconnect rewrote the config entry; re-read so the
        // inspector/list reflect it. The result is returned so the caller
        // (ConnectorInspector) can render the success/error banner.
        if (result.ok) void refreshStatus();
        return result;
      }),
    [refreshStatus],
  );

  const handleRemove = useCallback(
    (name: string): Promise<RemoveRemoteResult> => {
      // Record the in-app remove BEFORE the IPC call (see inAppRemoves above:
      // a poll tick racing the remove must find the name already excluded).
      inAppRemoves.current.add(name);
      return window.xcg
        .configRemoveRemote(name)
        .then((result) => {
          // Nothing written (noop/error) → the entry is still there; undo the
          // exclusion so a later real disappearance still notifies.
          if (!(result.ok && result.outcome === 'wrote')) inAppRemoves.current.delete(name);
          // ok covers both wrote (entry gone) and noop (not ours); refresh either
          // way so the list reflects reality. The result is returned so the
          // inspector can show the noop/error banner.
          if (result.ok) void refreshStatus();
          // wrote + tokensCleared:false → the best-effort Keychain clear failed;
          // queue the residual-credentials notice (no-op for any other result).
          setResidualCreds((prev) => accumulateResidualCredentials(prev, name, result));
          return result;
        })
        .catch((err: unknown) => {
          inAppRemoves.current.delete(name);
          throw err;
        });
    },
    [refreshStatus],
  );

  return (
    <div className={styles['app']}>
      <div className={styles['titlebar']} />
      <header className={styles['header']}>
        <span className={styles['titleGroup']}>
          <span className={styles['titleRow']}>
            <span
              className={`${styles['pulse']} ${pulseVariantClass}`}
              title={pulseTooltip}
              aria-label={`System health: ${health?.status ?? 'unknown'}`}
            />
            <h1 className={styles['title']}>xCLAUDE Gateway</h1>
            <span className={styles['betaPill']}>beta</span>
          </span>
          <span className={styles['trust']}>Audited locally · No account · No telemetry</span>
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
      <ResidualCredentialsWarning
        names={residualCreds}
        onDismiss={() => setResidualCreds([])}
      />
      <VanishedConnectorsWarning
        names={vanished}
        onReAdd={handleReAdd}
        onDismiss={() => setVanished([])}
      />
      {activeTab === 'setup' ? (
        <Setup
          status={configStatus}
          addOpen={addOpen}
          onAddOpenChange={setAddOpen}
          onRefresh={refreshStatus}
          onOpenInDetections={handleOpenInDetections}
          onAudit={handleAudit}
          onReconnect={handleReconnect}
          onRemove={handleRemove}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <Detections
          mcpFilter={detectionsMcpFilter}
          onClearMcpFilter={() => setDetectionsMcpFilter(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDrawer
          status={configStatus}
          onRefresh={refreshStatus}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
