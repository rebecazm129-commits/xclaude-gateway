import { useEffect, useState } from 'react';

import type { DetectionEvent } from '../../shared/types.js';

const POLL_INTERVAL_MS = 2000;

export function usePolledDetections(): DetectionEvent[] {
  const [detections, setDetections] = useState<DetectionEvent[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const result = await window.xcg.listDetections();
        if (!cancelled) setDetections(result);
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
