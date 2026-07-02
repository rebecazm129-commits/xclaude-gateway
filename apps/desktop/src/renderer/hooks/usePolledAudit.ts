import { useEffect, useState } from 'react';

import type {
  EnrichableEvent,
  ConnectorAuthAlert,
  RetentionBannerInfo,
} from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;

interface PolledAudit {
  events: EnrichableEvent[];
  authAlerts: ConnectorAuthAlert[];
  retention: RetentionBannerInfo | null;
}

// Single poll of detection:list → both the event list and the derived auth
// alerts (slice A's readAudit shape). Base hook: usePolledDetections delegates
// to it, so there is one poller per mounted tab and no extra disk scan.
export function usePolledAudit(): PolledAudit {
  const [audit, setAudit] = useState<PolledAudit>({
    events: [],
    authAlerts: [],
    retention: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const result = await window.xcg.listDetections();
        if (!cancelled) {
          setAudit({
            events: result.events,
            authAlerts: result.authAlerts,
            retention: result.retention ?? null,
          });
        }
      } catch (err) {
        console.error('listDetections failed:', err);
      }
    }

    void refresh();
    const handle = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  return audit;
}
