import { describe, expect, it } from 'vitest';

import { computeReloginTransitions } from '../../src/main/relogin-notify.js';

const set = (...xs: string[]): Set<string> => new Set(xs);

describe('computeReloginTransitions', () => {
  it('a) unseeded: seeds without notifying', () => {
    const r = computeReloginTransitions(set(), set('notion', 'slack'), false);
    expect(r.toNotify).toEqual([]);
    expect([...r.nextNotified].sort()).toEqual(['notion', 'slack']);
    expect(r.nextSeeded).toBe(true);
  });

  it('b) seeded: a newly-alerting connector is notified', () => {
    const r = computeReloginTransitions(set('notion'), set('notion', 'slack'), true);
    expect(r.toNotify).toEqual(['slack']);
    expect([...r.nextNotified].sort()).toEqual(['notion', 'slack']);
    expect(r.nextSeeded).toBe(true);
  });

  it('c) seeded: a recovered connector is not notified and drops out', () => {
    const r = computeReloginTransitions(set('notion'), set(), true);
    expect(r.toNotify).toEqual([]);
    expect(r.nextNotified.has('notion')).toBe(false);
  });

  it('d) seeded: a recovered-then-refailed connector notifies again', () => {
    // prev no longer has 'notion' (it recovered earlier); now it fails again.
    const r = computeReloginTransitions(set(), set('notion'), true);
    expect(r.toNotify).toEqual(['notion']);
    expect(r.nextNotified.has('notion')).toBe(true);
  });
});
