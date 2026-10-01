import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectResult, RemoveRemoteResult, StatusResult } from '@xcg/shared/config';

import { CLAUDE_CODE_SOURCE, type CchookManagedSettings } from '../shared/types.js';

import { ClaudeCode } from './components/ClaudeCode.js';
import { Changes } from './components/Changes.js';
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
import { CchookUpdateCard } from './components/CchookUpdateCard.js';
import { ToastStack, droppedToastText, type ToastItem } from './components/Toasts.js';
import { CchookManagedNotice, managedNoticeToShow } from './components/CchookManagedNotice.js';
import { CchookProfileNotice } from './components/CchookProfileNotice.js';
import { CchookVanishedWarning } from './components/CchookVanishedWarning.js';
import { Tabs, type TabOption } from './components/Tabs.js';
import { usePolledHealth } from './hooks/usePolledHealth.js';
import { usePolledConfigStatus } from './hooks/usePolledConfigStatus.js';
import { usePolledCchookStatus } from './hooks/usePolledCchookStatus.js';
import { reconnectConnector } from './lib/reconnect.js';

import styles from './App.module.css';

type TabId = 'setup' | 'detections' | 'changes' | 'claude-code';

const TAB_OPTIONS: readonly TabOption<TabId>[] = [
  { id: 'setup', label: 'Sources' },
  { id: 'detections', label: 'Detections' },
  // "MCP changes", not "Changes": xCLAUDE audits Claude Code too, so the bare
  // noun would not say whose surface moved.
  { id: 'changes', label: 'MCP changes' },
  { id: 'claude-code', label: 'Claude Code' },
];

const LAST_TAB_STORAGE_KEY = 'xcg:lastTab';

function readLastTab(): TabId | null {
  try {
    const stored = window.localStorage.getItem(LAST_TAB_STORAGE_KEY);
    if (stored === 'setup' || stored === 'detections' || stored === 'changes' || stored === 'claude-code') {
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
  // One-shot preset for Detections' source filter (the Claude Code inspector's
  // "Open in Detections"). Consumed by Detections (applied to its own state)
  // and cleared here — unlike mcpFilter, the sources selection LIVES in
  // Detections; App only hands over the initial value.
  const [detectionsSourcesPreset, setDetectionsSourcesPreset] =
    useState<readonly string[] | null>(null);
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
  // Hook-integrity notice (persisted by main in claude-code/hook-state.json):
  // App polls its own cchook:status instance so the banner below renders on
  // every tab, not only while Sources is mounted.
  const { status: cchookStatus, refresh: refreshCchookStatus } = usePolledCchookStatus();
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

  // Dismiss on a ~/.claude-* profile notice: persisted by path in the main
  // process; the status re-read drops it.
  const handleDismissProfile = useCallback(
    (path: string) => {
      if (window.xcg.cchookDismissProfile === undefined) return;
      void window.xcg
        .cchookDismissProfile(path)
        .then(() => refreshCchookStatus())
        .catch((err) => console.error('cchook:dismiss-profile failed:', err));
    },
    [refreshCchookStatus],
  );

  // Opening the Claude Code tab (or landing on it) rescans the ~/.claude-*
  // profiles instead of waiting for the once-a-minute scan.
  useEffect(() => {
    if (activeTab !== 'claude-code' || window.xcg.cchookRescanProfiles === undefined) return;
    void window.xcg
      .cchookRescanProfiles()
      .then(() => refreshCchookStatus())
      .catch((err) => console.error('cchook:rescan-profiles failed:', err));
  }, [activeTab, refreshCchookStatus]);

  // "Re-add connectors": jump to the Connectors tab (the modal lives inside
  // Setup) and open the Add connector modal. Deliberately does NOT dismiss
  // the notice — the user decides when the situation is handled.
  const handleReAdd = useCallback(() => {
    handleTabChange('setup');
    setAddOpen(true);
  }, [handleTabChange]);

  // Hook-integrity notice actions (CchookVanishedWarning). Both round-trip
  // through main, then re-read cchook:status so the banner reflects the
  // persisted state without waiting out the 2s tick.
  const handleReinstallHook = useCallback(() => {
    void window.xcg
      .cchookInstall()
      .then((result) => {
        if (result.ok) return refreshCchookStatus();
        if (result.managed !== undefined) setCchookManaged(result.managed);
        console.error('cchookInstall failed:', result.error);
        return undefined;
      })
      .catch((err) => console.error('cchookInstall failed:', err));
  }, [refreshCchookStatus]);

  // Hook update (CchookUpdateCard): only on the button. On success a
  // "Hooks updated" toast that closes on its own.
  const [hooksUpdated, setHooksUpdated] = useState(false);
  const [hooksUpdateError, setHooksUpdateError] = useState<string | null>(null);
  // An Install/Update that wrote nothing because settings.json is managed
  // externally: its notice (with the snippet) replaces the error text.
  const [cchookManaged, setCchookManaged] = useState<CchookManagedSettings | null>(null);
  const handleUpdateHooks = useCallback(() => {
    setHooksUpdateError(null);
    void window.xcg
      .cchookUpdate()
      .then((result) => {
        if (result.ok) {
          setHooksUpdated(true);
          return refreshCchookStatus();
        }
        if (result.managed !== undefined) setCchookManaged(result.managed);
        else setHooksUpdateError(result.error);
        return undefined;
      })
      .catch((err) => {
        console.error('cchookUpdate failed:', err);
        setHooksUpdateError(err instanceof Error ? err.message : String(err));
      });
  }, [refreshCchookStatus]);

  // Stable: the confirmation's timer would restart on every 2s poll render.
  const handleDismissUpdated = useCallback(() => setHooksUpdated(false), []);
  const handleNotNow = useCallback(
    (key: string) => {
      void window.xcg
        .cchookNotNow(key)
        .then(() => refreshCchookStatus())
        .catch((err) => console.error('cchookNotNow failed:', err));
    },
    [refreshCchookStatus],
  );

  const handleDismissDropped = useCallback(() => {
    void window.xcg
      .cchookDismissDropped()
      .then(() => refreshCchookStatus())
      .catch((err) => console.error('cchookDismissDropped failed:', err));
  }, [refreshCchookStatus]);

  const handleDismissCchookNotice = useCallback(() => {
    void window.xcg
      .cchookDismissVanished()
      .then(() => refreshCchookStatus())
      .catch((err) => console.error('cchookDismissVanished failed:', err));
  }, [refreshCchookStatus]);

  const handleOpenInDetections = useCallback((name: string) => {
    setDetectionsMcpFilter(name);
    setActiveTab('detections');
    writeLastTab('detections');
  }, []);

  // Claude Code variant: the right axis is the SOURCE filter, not mcp — its
  // events span several mcp names ('claude-code' for native tools, the real
  // server name for MCP tools consumed via hooks).
  const handleOpenClaudeCodeInDetections = useCallback(() => {
    setDetectionsMcpFilter(null);
    setDetectionsSourcesPreset([CLAUDE_CODE_SOURCE]);
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
      // Same scope as the first connect (catalog, matched by URL): see lib/reconnect.ts.
      reconnectConnector(window.xcg, name, url).then((result) => {
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
      <CchookVanishedWarning
        notice={cchookStatus?.pendingNotice ?? null}
        onReinstall={handleReinstallHook}
        onDismiss={handleDismissCchookNotice}
      />
      {/* Where the hook lives: Sources (install) and the Claude Code tab. */}
      {(activeTab === 'setup' || activeTab === 'claude-code') &&
      managedNoticeToShow(cchookStatus, cchookManaged) !== null ? (
        // Managed externally: nothing to update from here — the snippet to
        // paste instead.
        <CchookManagedNotice managed={managedNoticeToShow(cchookStatus, cchookManaged)} />
      ) : activeTab === 'claude-code' ? (
        // The update offer lives in the Claude Code tab only; Sources shows a
        // small "Hook update available" state in the inspector instead.
        <CchookUpdateCard
          check={cchookStatus?.hookCheck}
          prefs={cchookStatus?.hookUpdatePrefs}
          error={hooksUpdateError}
          onUpdate={handleUpdateHooks}
          onNotNow={handleNotNow}
        />
      ) : null}
      {/* ~/.claude-* profiles without our hook: informational, Claude Code tab only. */}
      {activeTab === 'claude-code'
        ? (cchookStatus?.unauditedProfiles ?? []).map((p) => (
            <CchookProfileNotice key={p.path} profile={p} onDismiss={handleDismissProfile} />
          ))
        : null}
      {activeTab === 'setup' ? (
        <Setup
          status={configStatus}
          addOpen={addOpen}
          onAddOpenChange={setAddOpen}
          onRefresh={refreshStatus}
          onOpenInDetections={handleOpenInDetections}
          onOpenClaudeCodeInDetections={handleOpenClaudeCodeInDetections}
          onAudit={handleAudit}
          onReconnect={handleReconnect}
          onRemove={handleRemove}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : activeTab === 'changes' ? (
        <Changes />
      ) : activeTab === 'claude-code' ? (
        <ClaudeCode />
      ) : (
        <Detections
          mcpFilter={detectionsMcpFilter}
          onClearMcpFilter={() => setDetectionsMcpFilter(null)}
          sourcesPreset={detectionsSourcesPreset}
          onSourcesPresetConsumed={() => setDetectionsSourcesPreset(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDrawer
          status={configStatus}
          onRefresh={refreshStatus}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {/* Toasts above the footer: spool drops (until Dismiss), and
          "Hooks updated" (closes on its own). */}
      <ToastStack
        toasts={[
          ...((cchookStatus?.spoolDropped?.count ?? 0) > 0
            ? [
                {
                  id: 'spool-dropped',
                  kind: 'warning',
                  text: droppedToastText(cchookStatus?.spoolDropped?.count ?? 0),
                  persistent: true,
                  actionLabel: 'Dismiss',
                  onAction: handleDismissDropped,
                } satisfies ToastItem,
              ]
            : []),
          ...(hooksUpdated
            ? [{ id: 'hooks-updated', kind: 'success', text: 'Hooks updated', onClose: handleDismissUpdated } satisfies ToastItem]
            : []),
        ]}
      />
    </div>
  );
}
