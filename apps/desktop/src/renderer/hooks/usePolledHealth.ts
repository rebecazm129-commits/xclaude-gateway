import { useCallback, useEffect, useState } from 'react';

import type { HealthResult } from '@xcg/shared';

const POLL_INTERVAL_MS = 10000;

export interface UsePolledHealthReturn {
  /** Latest health snapshot, or null while the first fetch is in flight. */
  health: HealthResult | null;
  /** Trigger an immediate refetch outside the polling interval. */
  refresh: () => Promise<void>;
}

/**
 * Polls the system:health IPC channel every 10 seconds.
 *
 * Pattern mirrors usePolledDetections but exposes a refresh() callback so the
 * refresh button in the header and the post-Repair flow can trigger an
 * immediate refetch without waiting for the next interval.
 *
 * Decided in C4.0 (Notion ficha 369242b46fa7817184cec3d0a0ce4647), microdec.
 * C4-3 (frequency: polling 10s + on-mount + on-refresh) and C4-D-2 (return
 * type with refresh callback for the refresh button + post-Repair flow).
 */
export function usePolledHealth(): UsePolledHealthReturn {
  const [health, setHealth] = useState<HealthResult | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.xcg.validateHealth();
      setHealth(result);
    } catch (err) {
      console.error('validateHealth failed:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const result = await window.xcg.validateHealth();
        if (!cancelled) setHealth(result);
      } catch (err) {
        console.error('validateHealth failed:', err);
      }
    }

    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  return { health, refresh };
}
