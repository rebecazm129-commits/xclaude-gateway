// Pure transition logic for connector re-login notifications. Decides which
// connectors carry a failure that has NOT been announced yet.
//
// Keyed by (mcp → lastFailureTs). The previous shape was a Set of connector
// names plus a `seeded` flag, both living in process memory: the first pass
// after every launch adopted whatever was already alerting and notified
// nothing. A failure that began while the app was closed was therefore never
// announced — not then, and not on any later launch. That is the 08-15/09
// stripe outage. Persisting the map (relogin-state.ts) and comparing the
// TIMESTAMP gives all three behaviours at once:
//   cold start with an unseen failure  → notify
//   restart with the same failure      → silent
//   new failure after a recovery       → notify again

export interface ReloginAlert {
  mcp: string;
  lastFailureTs: string;
}

export interface ReloginTransition {
  toNotify: ReloginAlert[];
  nextNotified: Map<string, string>;
}

export function computeReloginTransitions(
  prevNotified: ReadonlyMap<string, string>,
  current: readonly ReloginAlert[],
): ReloginTransition {
  const toNotify: ReloginAlert[] = [];
  // Mirrors `current`, so a connector that recovered drops out of the record
  // and a later re-failure is announced even if its timestamp repeated.
  const nextNotified = new Map<string, string>();
  for (const alert of current) {
    nextNotified.set(alert.mcp, alert.lastFailureTs);
    if (prevNotified.get(alert.mcp) !== alert.lastFailureTs) toNotify.push(alert);
  }
  return { toNotify, nextNotified };
}
