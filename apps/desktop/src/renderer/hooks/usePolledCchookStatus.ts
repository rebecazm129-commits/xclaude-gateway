import { useEffect, useState } from 'react';

import type { CchookStatus } from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;

// 2s poll of cchook:status — same shape as usePolledAudit. null until the
// first tick resolves (Setup treats null as "hook not registered": the
// Claude Code section simply doesn't render yet).
export function usePolledCchookStatus(): CchookStatus | null {
  const [status, setStatus] = useState<CchookStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const next = await window.xcg.cchookStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        // Poll failure degrades to the previous snapshot; logged (F2-01).
        console.error('cchook:status poll failed:', err);
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}
