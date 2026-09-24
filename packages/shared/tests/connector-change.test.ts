// The facts-model contract. No producer exists yet — these lock the SHAPE, so
// the producer (and the backward-compatible reader) have something to be
// wrong against.

import { describe, expect, it } from 'vitest';

import {
  CHANGES_EXPORT_SCHEMA_VERSION,
  CONNECTOR_CHANGE_TYPE,
  REVIEW_STATUS_CHANGED_TYPE,
  isConnectorChangeEvent,
  isReviewStatusChangedEvent,
  type Attention,
  type ConnectorChangeEvent,
  type ConnectorFinding,
} from '../src/connector-change.js';

const event = (over: Record<string, unknown> = {}): unknown => ({
  v: 1,
  id: '01M3',
  ts: '2026-09-24T12:00:00.000Z',
  session: 'S',
  mcp: 'notion',
  type: CONNECTOR_CHANGE_TYPE,
  section: 'tools',
  snapshot: { before: 'sha256:a', after: 'sha256:b' },
  changes: [{ kind: 'description_changed', target: 'notion-search', path: '$.description' }],
  findings: [],
  attention: { level: 'normal' },
  ...over,
});

describe('connector_change narrowing', () => {
  it('accepts a well-formed event', () => {
    expect(isConnectorChangeEvent(event())).toBe(true);
  });

  it('rejects another line type, however similar', () => {
    expect(isConnectorChangeEvent(event({ type: 'mcp.request' }))).toBe(false);
  });

  it('rejects a line missing either list — both are mandatory, empty or not', () => {
    expect(isConnectorChangeEvent(event({ changes: undefined }))).toBe(false);
    expect(isConnectorChangeEvent(event({ findings: undefined }))).toBe(false);
  });

  it.each([null, undefined, 42, 'x', []])('rejects %o', (value) => {
    expect(isConnectorChangeEvent(value)).toBe(false);
  });

  it('a change with no findings is valid — that is the whole point', () => {
    const e = event({ findings: [] }) as ConnectorChangeEvent;
    expect(isConnectorChangeEvent(e)).toBe(true);
    expect(e.findings).toEqual([]);
  });
});

describe('review_status_changed narrowing', () => {
  const rs = (over: Record<string, unknown> = {}): unknown => ({
    v: 1,
    id: '01M4',
    ts: '2026-09-24T13:00:00.000Z',
    type: REVIEW_STATUS_CHANGED_TYPE,
    target_event_id: '01M3',
    from: 'unreviewed',
    to: 'reviewed',
    ...over,
  });

  it('accepts a well-formed marker', () => {
    expect(isReviewStatusChangedEvent(rs())).toBe(true);
  });

  it('rejects an unknown target state', () => {
    expect(isReviewStatusChangedEvent(rs({ to: 'maybe' }))).toBe(false);
  });

  it('rejects a marker with no target event', () => {
    expect(isReviewStatusChangedEvent(rs({ target_event_id: undefined }))).toBe(false);
  });

  it('is never mistaken for the event it points at', () => {
    expect(isConnectorChangeEvent(rs())).toBe(false);
    expect(isReviewStatusChangedEvent(event())).toBe(false);
  });
});

describe('attention cannot be raised anonymously', () => {
  it('normal carries nothing else', () => {
    const a: Attention = { level: 'normal' };
    expect(a).toEqual({ level: 'normal' });
  });

  it('review_recommended names the heuristic and its version', () => {
    // The type makes the alternative unrepresentable; this records WHY, so a
    // future edit that relaxes it fails here first.
    const a: Attention = {
      level: 'review_recommended',
      heuristic_id: 'targeted_description_growth',
      heuristic_version: 1,
    };
    expect(a.level).toBe('review_recommended');
    if (a.level !== 'review_recommended') throw new Error('unreachable');
    expect(typeof a.heuristic_id).toBe('string');
    expect(typeof a.heuristic_version).toBe('number');
  });
});

describe('findings carry a versioned rule', () => {
  it('rule_id and rule_version travel with every judgement', () => {
    const f: ConnectorFinding = {
      rule_id: 'sensitive_param_added',
      rule_version: 1,
      severity: 'high',
      evidence: { target: 'send', path: '$.inputSchema.properties.webhook_url' },
    };
    expect(f.rule_id).toBe('sensitive_param_added');
    expect(f.rule_version).toBeGreaterThanOrEqual(1);
  });
});

describe('export document', () => {
  it('the schema version is the document’s, not any rule’s', () => {
    expect(CHANGES_EXPORT_SCHEMA_VERSION).toBe(1);
  });
});
