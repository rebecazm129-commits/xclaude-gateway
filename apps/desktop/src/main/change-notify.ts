// Connector changes that reach the user with the window closed: the tray line
// and the macOS notification. Pure — index.ts reads the changes, shows the
// notifications and writes the markers.
//
// TRAY. "{n} changes to review (24h)": changes of the last 24 hours, still
// unreviewed, whose strongest finding is medium or above — manifest and
// authorization alike. A change with no finding never counts: it is a fact,
// not something to look at.
//
// NOTIFICATIONS. Only the two authorization rules, on the Chrome pattern: an
// increase in what a connector can do interrupts. One per change event, keyed
// by event_id: a change an app.change_notified marker already points at is
// never announced again, across restarts. Only changes of the last 24 hours,
// so a fresh install (or a purged app-events file) does not replay history.

import { DAY_MS } from '../shared/types.js';
import type { ChangeFinding, ConnectorChangeView } from './connector-changes.js';

const RANK: Record<ChangeFinding['severity'], number> = { low: 0, medium: 1, high: 2, critical: 3 };

function strongest(view: ConnectorChangeView): ChangeFinding['severity'] | null {
  let best: ChangeFinding['severity'] | null = null;
  for (const f of view.findings) if (best === null || RANK[f.severity] > RANK[best]) best = f.severity;
  return best;
}

function recent(view: ConnectorChangeView, nowMs: number): boolean {
  const t = Date.parse(view.ts);
  return Number.isFinite(t) && t >= nowMs - DAY_MS;
}

export function computeChangesToReview(views: readonly ConnectorChangeView[], nowMs: number): number {
  let n = 0;
  for (const v of views) {
    if (v.review_status !== 'unreviewed' || !recent(v, nowMs)) continue;
    const s = strongest(v);
    if (s !== null && RANK[s] >= RANK.medium) n++;
  }
  return n;
}

export interface ChangeNotification {
  eventId: string;
  mcp: string;
  ruleId: 'authorization_server_changed' | 'scopes_expanded';
  title: string;
  body: string;
}

export const CHANGE_NOTIFICATION_BODY = 'Review it in xCLAUDE Gateway before using this connector.';

/** At most one per event: a changed server outranks expanded permissions. */
export function computeChangeNotifications(
  views: readonly ConnectorChangeView[],
  nowMs: number,
  alreadyNotified: ReadonlySet<string> = new Set(),
): ChangeNotification[] {
  const out: ChangeNotification[] = [];
  for (const v of views) {
    if (v.section !== 'authorization' || v.notified === true || alreadyNotified.has(v.event_id)) continue;
    if (!recent(v, nowMs)) continue;
    const rules = new Set(v.findings.map((f) => f.rule_id));
    if (rules.has('authorization_server_changed')) {
      out.push({
        eventId: v.event_id,
        mcp: v.mcp,
        ruleId: 'authorization_server_changed',
        title: `${v.mcp}: authorization server changed`,
        body: CHANGE_NOTIFICATION_BODY,
      });
    } else if (rules.has('scopes_expanded')) {
      out.push({
        eventId: v.event_id,
        mcp: v.mcp,
        ruleId: 'scopes_expanded',
        title: `${v.mcp}: permissions expanded`,
        body: CHANGE_NOTIFICATION_BODY,
      });
    }
  }
  return out;
}
