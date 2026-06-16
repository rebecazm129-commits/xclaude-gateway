import type { EnrichableEvent } from '../../shared/types.js';
import { usePolledAudit } from './usePolledAudit.js';

// Thin view over usePolledAudit for consumers that only need the event list
// (Detections, ConnectorInspector). Shares the single poll — no extra disk scan.
export function usePolledDetections(): EnrichableEvent[] {
  return usePolledAudit().events;
}
