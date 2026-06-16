import { useEffect, useState } from 'react';

import type { EnrichableEvent } from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;

export function usePolledDetections(): EnrichableEvent[] {
  const [detections, setDetections] = useState<EnrichableEvent[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const result = await window.xcg.listDetections();
        if (!cancelled) setDetections(result.events);
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

  return detections;
}
