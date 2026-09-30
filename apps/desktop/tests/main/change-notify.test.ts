// The tray's review count and the authorization notifications (change-notify),
// and the app.change_notified marker that keeps a notification from firing
// twice: written by recovery-writer, folded back by readConnectorChanges.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CHANGE_NOTIFICATION_BODY,
  computeChangeNotifications,
  computeChangesToReview,
} from '../../src/main/change-notify.js';
import { readConnectorChanges, type ConnectorChangeView } from '../../src/main/connector-changes.js';
import { parseAuditContent } from '../../src/main/detection-reader.js';
import { APP_EVENTS_FILENAME, CHANGE_NOTIFIED_TYPE, writeChangeNotified } from '../../src/main/recovery-writer.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

let seq = 0;
function view(over: Partial<ConnectorChangeView>): ConnectorChangeView {
  return {
    event_id: `e${(seq += 1)}`,
    ts: at(1),
    mcp: 'linear',
    section: 'tools',
    snapshot: null,
    changes: [],
    findings: [],
    attention: { level: 'normal' },
    review_status: 'unreviewed',
    review_history: [],
    ...over,
  };
}
const finding = (rule_id: string, severity: 'low' | 'medium' | 'high' | 'critical') =>
  ({ rule_id, rule_version: 1, severity, evidence: {} }) as ConnectorChangeView['findings'][number];

describe('computeChangesToReview', () => {
  it('counts unreviewed changes of the last 24h with a medium-or-above finding, manifest and authorization alike', () => {
    const views = [
      view({ findings: [finding('injection_marker', 'high')] }), // manifest, high
      view({ section: 'authorization', findings: [finding('scopes_expanded', 'medium')] }),
      view({ section: 'authorization', findings: [finding('authorization_server_changed', 'high')] }),
    ];
    expect(computeChangesToReview(views, NOW)).toBe(3);
  });

  it('leaves out: no finding, only low, reviewed, older than 24h', () => {
    const views = [
      view({}),
      view({ findings: [finding('hidden_characters', 'low')] }),
      view({ findings: [finding('injection_marker', 'high')], review_status: 'reviewed' }),
      view({ findings: [finding('injection_marker', 'high')], ts: at(25) }),
    ];
    expect(computeChangesToReview(views, NOW)).toBe(0);
  });
});

describe('computeChangeNotifications', () => {
  it('authorization server changed and permissions expanded, with their titles and one body', () => {
    const out = computeChangeNotifications(
      [
        view({ event_id: 'a', mcp: 'linear', section: 'authorization', findings: [finding('authorization_server_changed', 'high')] }),
        view({ event_id: 'b', mcp: 'github', section: 'authorization', findings: [finding('scopes_expanded', 'medium')] }),
      ],
      NOW,
    );
    expect(out).toEqual([
      { eventId: 'a', mcp: 'linear', ruleId: 'authorization_server_changed', title: 'linear: authorization server changed', body: CHANGE_NOTIFICATION_BODY },
      { eventId: 'b', mcp: 'github', ruleId: 'scopes_expanded', title: 'github: permissions expanded', body: CHANGE_NOTIFICATION_BODY },
    ]);
    expect(CHANGE_NOTIFICATION_BODY).toBe('Review it in xCLAUDE Gateway before using this connector.');
  });

  it('one per event: a changed server outranks expanded permissions', () => {
    const out = computeChangeNotifications(
      [view({ section: 'authorization', findings: [finding('scopes_expanded', 'medium'), finding('authorization_server_changed', 'high')] })],
      NOW,
    );
    expect(out.map((n) => n.ruleId)).toEqual(['authorization_server_changed']);
  });

  it('never: already marked, already in this process, older than 24h, manifest findings, authorization facts', () => {
    const out = computeChangeNotifications(
      [
        view({ section: 'authorization', findings: [finding('scopes_expanded', 'medium')], notified: true }),
        view({ event_id: 'seen', section: 'authorization', findings: [finding('scopes_expanded', 'medium')] }),
        view({ section: 'authorization', findings: [finding('scopes_expanded', 'medium')], ts: at(25) }),
        view({ findings: [finding('injection_marker', 'high')] }),
        view({ section: 'authorization' }),
      ],
      NOW,
      new Set(['seen']),
    );
    expect(out).toEqual([]);
  });
});

describe('app.change_notified marker', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-change-notify-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const oauthLine = (id: string, ts: string) =>
    JSON.stringify({
      v: 1, id, ts, session: `s-${id}`, mcp: 'linear', type: 'proxy.oauth_authorized',
      authorization_server: 'https://login.other.example/', authorization_server_source: 'protected_resource_metadata',
      resource: 'https://mcp.linear.app/mcp', requested_scopes: ['read'], effective_granted_scopes: ['read'],
      scope_source: 'token_response', first_login: false, previous_login_at: '2026-09-29T10:00:00.000Z', changes: [],
      findings: [{ rule_id: 'authorization_server_changed', rule_version: 1, severity: 'high', before: 'https://auth.linear.app/', after: 'https://login.other.example/' }],
    });

  it('appends one well-formed envelope per decision, shown:false included', async () => {
    const d = join(dir, 'shape');
    writeChangeNotified({ mcp: 'linear', targetEventId: 'evt-1', ruleId: 'authorization_server_changed', shown: true }, d);
    writeChangeNotified({ mcp: 'github', targetEventId: 'evt-2', ruleId: 'scopes_expanded', shown: false }, d);
    const lines = (await readFile(join(d, APP_EVENTS_FILENAME), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      v: 1, session: 'desktop', mcp: 'linear', type: CHANGE_NOTIFIED_TYPE,
      target_event_id: 'evt-1', rule_id: 'authorization_server_changed', shown: true,
    });
    expect(lines[1]).toMatchObject({ target_event_id: 'evt-2', shown: false });
  });

  it('dedupes across restarts: the marker folds back onto the change, which is then never notified again', async () => {
    const d = join(dir, 'dedupe');
    await rm(d, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.mkdir(d, { recursive: true }));
    await writeFile(join(d, 'session.jsonl'), `${oauthLine('evt-auth', at(1))}\n`);

    const before = await readConnectorChanges(d);
    expect(computeChangeNotifications(before, NOW).map((n) => n.eventId)).toEqual(['evt-auth']);

    writeChangeNotified({ mcp: 'linear', targetEventId: 'evt-auth', ruleId: 'authorization_server_changed', shown: true }, d);
    // A fresh process: no in-memory set, only the trail.
    const after = await readConnectorChanges(d);
    expect(after.find((v) => v.event_id === 'evt-auth')?.notified).toBe(true);
    expect(computeChangeNotifications(after, NOW)).toEqual([]);
  });

  it('is inert for the detection reader: no detection event, no auth signal, no outcome', async () => {
    const d = join(dir, 'inert');
    writeChangeNotified({ mcp: 'linear', targetEventId: 'evt-x', ruleId: 'scopes_expanded', shown: true }, d);
    const parsed = parseAuditContent(await readFile(join(d, APP_EVENTS_FILENAME), 'utf8'));
    expect(parsed.events).toEqual([]);
    expect(parsed.authSignals).toEqual([]);
    expect(parsed.outcomes?.size ?? 0).toBe(0);
  });
});
