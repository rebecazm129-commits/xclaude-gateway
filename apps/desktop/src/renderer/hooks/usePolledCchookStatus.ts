import { useCallback, useEffect, useState } from 'react';

import type { CchookStatus } from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;

export interface UsePolledCchookStatusReturn {
  /** Latest snapshot, or null while the first tick is in flight. */
  status: CchookStatus | null;
  /** Trigger an immediate refetch outside the polling interval. */
  refresh: () => Promise<void>;
}

// 2s poll of cchook:status — same shape as usePolledAudit, plus refresh()
// (usePolledConfigStatus precedent) so App's hook-integrity banner re-reads
// right after a Reinstall/Dismiss instead of waiting out the tick. status is
// null until the first tick resolves (Setup treats null as "hook not
// registered": the Claude Code section simply doesn't render yet).
export function usePolledCchookStatus(): UsePolledCchookStatusReturn {
  const [status, setStatus] = useState<CchookStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.xcg.cchookStatus();
      setStatus(next);
    } catch (err) {
      // Refresh failure degrades to the previous snapshot; logged (F2-01).
      console.error('cchook:status poll failed:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const next = await window.xcg.cchookStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        // Poll failure degrades to the previous snapshot; logged (F2-01).
        console.error('cchook:status poll failed:', err);
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { status, refresh };
}
