import { describe, expect, it } from 'vitest';

import { InflightTracker, invertDirection } from '../src/latency.js';

describe('InflightTracker', () => {
  it('matches a request with its response and clears the entry', () => {
    const t = new InflightTracker();
    t.trackRequest('client_to_server', 1, 1000);
    expect(t.size()).toBe(1);

    const latency = t.matchResponse('server_to_client', 1, 1050);
    expect(latency).toBe(50);
    expect(t.size()).toBe(0);
  });

  it('returns undefined for an orphan response (no prior request)', () => {
    const t = new InflightTracker();
    const latency = t.matchResponse('server_to_client', 99, 100);
    expect(latency).toBeUndefined();
    expect(t.size()).toBe(0);
  });

  it('keeps an orphan request in the map (no TTL)', () => {
    const t = new InflightTracker();
    t.trackRequest('client_to_server', 1, 1000);
    expect(t.size()).toBe(1);
    // Sin match: el request permanece. Sin TTL en Fase 5.
    expect(t.size()).toBe(1);
  });

  it('does not collide on same rpcId across opposite directions', () => {
    const t = new InflightTracker();
    t.trackRequest('client_to_server', 1, 1000);
    t.trackRequest('server_to_client', 1, 2000);
    expect(t.size()).toBe(2);

    // Response s2c matchea el request c2s.
    expect(t.matchResponse('server_to_client', 1, 1050)).toBe(50);
    expect(t.size()).toBe(1);

    // Response c2s matchea el request s2c.
    expect(t.matchResponse('client_to_server', 1, 2200)).toBe(200);
    expect(t.size()).toBe(0);
  });

  it('overwrites a duplicate request and matches against the most recent ts', () => {
    const t = new InflightTracker();
    t.trackRequest('client_to_server', 1, 1000);
    t.trackRequest('client_to_server', 1, 5000); // overwrite
    expect(t.size()).toBe(1);

    const latency = t.matchResponse('server_to_client', 1, 5050);
    expect(latency).toBe(50); // contra el segundo, no contra el primero (4050)
  });

  it('returns negative latency without clamping (NTP step pass-through)', () => {
    const t = new InflightTracker();
    t.trackRequest('client_to_server', 1, 5000);
    const latency = t.matchResponse('server_to_client', 1, 4000);
    expect(latency).toBe(-1000);
    expect(t.size()).toBe(0);
  });
});

describe('invertDirection', () => {
  it('flips client_to_server ↔ server_to_client and is its own inverse', () => {
    expect(invertDirection('client_to_server')).toBe('server_to_client');
    expect(invertDirection('server_to_client')).toBe('client_to_server');
    expect(invertDirection(invertDirection('client_to_server'))).toBe('client_to_server');
  });
});
