// Pure transition logic for connector re-login notifications. Decides which
// connectors just ENTERED the "needs re-login" state, so the main process
// notifies once per transition. First evaluation seeds without notifying.
export interface ReloginTransition {
  toNotify: string[];
  nextNotified: Set<string>;
  nextSeeded: boolean;
}

export function computeReloginTransitions(
  prevNotified: Set<string>,
  currentMcps: Set<string>,
  seeded: boolean,
): ReloginTransition {
  // First pass: adopt whatever is already alerting; notify nothing.
  if (!seeded) {
    return { toNotify: [], nextNotified: new Set(currentMcps), nextSeeded: true };
  }
  // Steady state: notify connectors alerting now that weren't accounted for.
  // nextNotified mirrors `current`, so recovered connectors drop out (a later
  // re-failure notifies again) and still-alerting ones don't repeat.
  const toNotify = [...currentMcps].filter((mcp) => !prevNotified.has(mcp));
  return { toNotify, nextNotified: new Set(currentMcps), nextSeeded: true };
}
