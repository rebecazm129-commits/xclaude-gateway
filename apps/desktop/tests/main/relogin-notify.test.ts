import { describe, expect, it } from 'vitest';

import { computeReloginTransitions, type ReloginAlert } from '../../src/main/relogin-notify.js';

const alert = (mcp: string, ts: string): ReloginAlert => ({ mcp, lastFailureTs: ts });
const T1 = '2026-09-08T05:08:12.557Z';
const T2 = '2026-09-22T18:58:20.421Z';

describe('computeReloginTransitions', () => {
  it('a) cold start with nothing recorded: announces every alert', () => {
    // The old shape seeded silently here and never spoke again — the 08-15/09
    // stripe outage in one line.
    const r = computeReloginTransitions(new Map(), [alert('notion', T1), alert('slack', T1)]);
    expect(r.toNotify.map((a) => a.mcp)).toEqual(['notion', 'slack']);
    expect([...r.nextNotified.entries()].sort()).toEqual([
      ['notion', T1],
      ['slack', T1],
    ]);
  });

  it('b) the same failure again: silent', () => {
    const prev = new Map([['stripe', T1]]);
    const r = computeReloginTransitions(prev, [alert('stripe', T1)]);
    expect(r.toNotify).toEqual([]);
    expect(r.nextNotified.get('stripe')).toBe(T1);
  });

  it('c) a NEW failure for an already-known connector: announced again', () => {
    const prev = new Map([['stripe', T1]]);
    const r = computeReloginTransitions(prev, [alert('stripe', T2)]);
    expect(r.toNotify).toEqual([alert('stripe', T2)]);
    expect(r.nextNotified.get('stripe')).toBe(T2);
  });

  it('d) a recovered connector drops out of the record', () => {
    const prev = new Map([['stripe', T1]]);
    const r = computeReloginTransitions(prev, []);
    expect(r.toNotify).toEqual([]);
    expect(r.nextNotified.has('stripe')).toBe(false);
  });

  it('e) recovered then re-failed with the SAME timestamp: announced again', () => {
    // The record was cleared by (d), so there is nothing to suppress against.
    const r = computeReloginTransitions(new Map(), [alert('stripe', T1)]);
    expect(r.toNotify).toEqual([alert('stripe', T1)]);
  });

  it('f) one connector known, another new: only the new one', () => {
    const prev = new Map([['notion', T1]]);
    const r = computeReloginTransitions(prev, [alert('notion', T1), alert('stripe', T2)]);
    expect(r.toNotify.map((a) => a.mcp)).toEqual(['stripe']);
    expect(r.nextNotified.size).toBe(2);
  });

  it('g) a restart is just an empty prev when the file is unreadable: notifies', () => {
    // readNotified degrades an unreadable file to an empty map on purpose — a
    // duplicate notification is an acceptable cost, a missed one is not.
    const r = computeReloginTransitions(new Map(), [alert('stripe', T1)]);
    expect(r.toNotify).toHaveLength(1);
  });
});
