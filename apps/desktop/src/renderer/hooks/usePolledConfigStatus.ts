import { useCallback, useEffect, useState } from 'react';

import type { StatusResult } from '@xcg/shared/config';

const POLL_INTERVAL_MS = 10000;

// Current + previous DISTINCT results, moved atomically in one state object.
// `previous` exists for the out-of-band diff (F2-04 step 2): comparing two
// consecutive distinct snapshots tells which managed connectors disappeared
// from the config between ticks. Step 1 only carries it; nothing consumes it yet.
interface StatusSnapshot {
  current: StatusResult | null;
  previous: StatusResult | null;
}

export interface UsePolledConfigStatusReturn {
  /** Latest config status, or null while the first fetch is in flight. */
  status: StatusResult | null;
  /** The distinct status BEFORE the latest change; null until a second distinct result. */
  previous: StatusResult | null;
  /** Trigger an immediate refetch outside the polling interval. */
  refresh: () => Promise<void>;
}

/**
 * Polls config:status every 10 seconds, mirroring usePolledHealth (polling +
 * on-mount + refresh() for the header button and post-action re-reads), with
 * one addition the precedent lacks: DEDUPE. A tick whose result deep-equals
 * the current one keeps the SAME reference, so App/Setup do not re-render
 * every 10s when nothing changed. A failed tick logs and keeps the last good
 * state, exactly like the precedent.
 *
 * This replaces App's old one-shot config read: out-of-band config changes
 * (Claude Desktop rewriting mcpServers, a manual edit) now reach the UI
 * within one tick instead of waiting for a user action (F2-04).
 */
export function usePolledConfigStatus(): UsePolledConfigStatusReturn {
  const [snap, setSnap] = useState<StatusSnapshot>({ current: null, previous: null });

  // Dedupe gate: StatusResult is plain JSON from IPC with stable key order
  // (built by the same handler every time), so stringify equality is a sound
  // deep-equal here.
  const apply = useCallback((result: StatusResult): void => {
    setSnap((prev) => {
      if (prev.current !== null && JSON.stringify(prev.current) === JSON.stringify(result)) {
        return prev;
      }
      return { current: result, previous: prev.current };
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.xcg.configStatus();
      apply(result);
    } catch (err) {
      console.error('configStatus failed:', err);
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const result = await window.xcg.configStatus();
        if (!cancelled) apply(result);
      } catch (err) {
        console.error('configStatus failed:', err);
      }
    }

    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [apply]);

  return { status: snap.current, previous: snap.previous, refresh };
}
