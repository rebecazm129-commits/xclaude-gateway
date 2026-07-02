import { mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { paginate, toSlim } from '../src/main/detection-page.js';
import { createAuditStore } from '../src/main/audit-store.js';
import { readAudit } from '../src/main/detection-reader.js';
import type {
  Category,
  DetectionCursor,
  DetectionFilter,
  EnrichableEvent,
  Severity,
} from '../src/shared/types.js';

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const CATS: Category[] = [
  'credential_detected', 'prompt_injection', 'email_send_warning',
  'data_export_warning', 'tool_call_allowed', 'pii_detected', 'pii_structured',
];
const SEVS: Severity[] = ['low', 'medium', 'high', 'critical'];
const ALL: DetectionFilter = { mcp: null, timeRange: 'all', categories: [...CATS], severities: [...SEVS] };

function req(
  id: string,
  ts: string,
  opts: { mcp?: string; category?: Category; severity?: Severity; args?: unknown } = {},
): EnrichableEvent {
  const e = {
    id, ts, session: 's', mcp: opts.mcp ?? 'm', type: 'mcp.request' as const,
    method: 'tools/call', rpcId: 1, direction: 'client_to_server' as const,
    toolName: 'echo',
    detection: {
      category: opts.category ?? 'tool_call_allowed',
      severity: opts.severity ?? 'low',
      findings: [],
    },
  } as EnrichableEvent;
  if (opts.args !== undefined) {
    (e as { argumentsJson?: string }).argumentsJson = JSON.stringify(opts.args, null, 2);
  }
  return e;
}

// Reference comparator + filter, computed independently of paginate (for the
// golden oracle). ts desc, id desc.
function cmp(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
const WINDOW: Record<'1h' | '24h' | '7d', number> = {
  '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR,
};
function referenceIds(events: readonly EnrichableEvent[], filter: DetectionFilter, now: number): string[] {
  const catSet = new Set(filter.categories);
  const sevSet = new Set(filter.severities);
  const cutoff = filter.timeRange === 'all' ? null : now - WINDOW[filter.timeRange];
  return events
    .filter((e) => {
      if (filter.mcp !== null && e.mcp !== filter.mcp) return false;
      if (cutoff !== null) {
        const t = Date.parse(e.ts);
        if (Number.isNaN(t) || t < cutoff) return false;
      }
      return catSet.has(e.detection.category) && sevSet.has(e.detection.severity);
    })
    .slice()
    .sort(cmp)
    .map((e) => e.id);
}

describe('paginate — filter before cut', () => {
  it('applies the severity filter BEFORE the top-N (deep criticals surface)', () => {
    const events: EnrichableEvent[] = [];
    // 50 low events (newer) then 3 criticals (older) — criticals are "deep".
    for (let i = 0; i < 50; i++) events.push(req(`low${i}`, new Date(NOW - i * 1000).toISOString()));
    for (let i = 0; i < 3; i++) events.push(req(`crit${i}`, new Date(NOW - (100 + i) * 1000).toISOString(), { severity: 'critical' }));
    const filter = { ...ALL, severities: ['critical'] as Severity[] };
    const p = paginate(events, filter, 2, null, NOW);
    expect(p.rows.map((r) => r.id)).toEqual(['crit0', 'crit1']);
    expect(p.totalMatching).toBe(3);
    expect(p.total).toBe(53);
  });
});

describe('paginate — counts', () => {
  it('severityCounts and categoryFilteredTotal reflect the category-filtered set', () => {
    const events = [
      req('a', new Date(NOW).toISOString(), { severity: 'low' }),
      req('b', new Date(NOW - 1000).toISOString(), { severity: 'critical' }),
      req('c', new Date(NOW - 2000).toISOString(), { severity: 'critical' }),
      req('d', new Date(NOW - 3000).toISOString(), { category: 'pii_detected', severity: 'high' }),
    ];
    // Category filter excludes pii_detected → d drops from the counted set.
    const filter = { ...ALL, categories: ['tool_call_allowed'] as Category[] };
    const p = paginate(events, filter, 10, null, NOW);
    expect(p.categoryFilteredTotal).toBe(3);
    expect(p.severityCounts).toEqual({ low: 1, medium: 0, high: 0, critical: 2 });
    expect(p.totalMatching).toBe(3);
    expect(p.total).toBe(4);
  });
});

describe('paginate — slim rows', () => {
  it('rows carry no argumentsJson (heavy field stays out of pages)', () => {
    const events = [req('a', new Date(NOW).toISOString(), { args: { big: 'x'.repeat(100) } })];
    const p = paginate(events, ALL, 10, null, NOW);
    expect(p.rows[0]).toEqual({
      id: 'a', ts: new Date(NOW).toISOString(), mcp: 'm',
      type: 'mcp.request', category: 'tool_call_allowed', severity: 'low',
      toolName: 'echo', method: 'tools/call',
    });
    expect('argumentsJson' in (p.rows[0] as object)).toBe(false);
  });
});

describe('paginate — cursor walk', () => {
  it('nextCursor is null when the page is not full', () => {
    const events = [req('a', new Date(NOW).toISOString()), req('b', new Date(NOW - 1000).toISOString())];
    expect(paginate(events, ALL, 10, null, NOW).nextCursor).toBeNull();
  });

  it('walks contiguous pages with no dup/gap, including ts ties', () => {
    const events: EnrichableEvent[] = [];
    // 10 events sharing ONE ts (ties) + 10 with distinct ts.
    const tie = new Date(NOW).toISOString();
    for (let i = 0; i < 10; i++) events.push(req(`tie${i}`, tie));
    for (let i = 0; i < 10; i++) events.push(req(`u${i}`, new Date(NOW - (i + 1) * 1000).toISOString()));
    const full = paginate(events, ALL, events.length + 5, null, NOW).rows.map((r) => r.id);
    // Walk in pages of 3.
    const walked: string[] = [];
    let cursor: DetectionCursor | null = null;
    for (;;) {
      const p = paginate(events, ALL, 3, cursor, NOW);
      walked.push(...p.rows.map((r) => r.id));
      if (p.nextCursor === null) break;
      cursor = p.nextCursor;
    }
    expect(walked).toEqual(full);
    expect(new Set(walked).size).toBe(walked.length); // no dup
    expect(walked.length).toBe(20); // no gap
  });
});

// ---- store-level + golden oracle ----

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xcg-page-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reqJson(id: string, ts: string, opts: { mcp?: string; category?: Category; severity?: Severity; args?: unknown } = {}): string {
  return JSON.stringify({
    v: 1, id, ts, session: 's', mcp: opts.mcp ?? 'm', type: 'mcp.request',
    direction: 'client_to_server', rpcId: 1, method: 'tools/call',
    params: { name: 'echo', ...(opts.args !== undefined ? { arguments: opts.args } : {}) },
    bytes: 10, overheadUs: 7,
    detection: { category: opts.category ?? 'tool_call_allowed', severity: opts.severity ?? 'low', findings: [] },
  });
}

describe('AuditStore.getDetail', () => {
  it('returns heavy fields for a known id and null for unknown / purged', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqJson('x1', new Date(NOW).toISOString(), { args: { q: 'hi' } }) + '\n');
    await writeFile(join(dir, 'b.jsonl'), reqJson('x2', new Date(NOW - 1000).toISOString()) + '\n');

    const d = await store.getDetail('x1');
    expect(d?.id).toBe('x1');
    expect(d?.argumentsJson).toBe(JSON.stringify({ q: 'hi' }, null, 2));
    expect(d?.overheadUs).toBe(7);

    expect(await store.getDetail('nope')).toBeNull();

    // Purge b.jsonl → its detail becomes cleanly unavailable.
    await unlink(join(dir, 'b.jsonl'));
    store.invalidate(['b.jsonl']);
    expect(await store.getDetail('x2')).toBeNull();
  });
});

describe('AuditStore — slim cache (entrega 2)', () => {
  it('get() events carry no heavy fields; detail reconstructs them from disk', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const bigArgs = { blob: 'z'.repeat(1000) };
    await writeFile(
      join(dir, 'a.jsonl'),
      reqJson('x1', new Date(NOW).toISOString(), { args: bigArgs }) + '\n',
    );
    const full = await store.get();
    const ev = full.events[0] as Record<string, unknown>;
    // Presentation fields kept:
    expect(ev['id']).toBe('x1');
    expect(ev['toolName']).toBe('echo');
    expect((ev['detection'] as { severity: string }).severity).toBe('low');
    // Heavy / raw fields dropped from the cache (and thus from get()):
    expect('argumentsJson' in ev).toBe(false);
    expect('params' in ev).toBe(false);
    expect('bytes' in ev).toBe(false);
    expect('overheadUs' in ev).toBe(false);
    // Detail re-reads the source line → heavy fields available again.
    const d = await store.getDetail('x1');
    expect(d?.argumentsJson).toBe(JSON.stringify(bigArgs, null, 2));
    expect(d?.overheadUs).toBe(7);
  });

  it('getDetail stays correct after a fail-safe full re-read (truncation)', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const l1 = reqJson('k1', new Date(NOW).toISOString(), { args: { a: 1 } });
    const l2 = reqJson('k2', new Date(NOW - 1000).toISOString(), { args: { b: 2 } });
    await writeFile(join(dir, 'a.jsonl'), l1 + '\n' + l2 + '\n');
    await store.get();
    expect((await store.getDetail('k2'))?.argumentsJson).toBe(JSON.stringify({ b: 2 }, null, 2));

    // Rewrite shorter (drop k2): size < offset → fail-safe full re-read.
    await writeFile(join(dir, 'a.jsonl'), l1 + '\n');
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 5000), new Date(NOW + 5000));
    await store.get();
    expect(await store.getDetail('k2')).toBeNull(); // gone
    expect((await store.getDetail('k1'))?.argumentsJson).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe('AuditStore.getPage — golden oracle vs readAudit', () => {
  it('page walk === filtered+sorted(ts,id) slim projection of readAudit, incl. ts ties', async () => {
    // Deterministic pseudo-random content with heavy ts collisions.
    let s = 0x1234;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const mcps = ['notion', 'linear', 'stripe'];
    const tsPool = [0, 0, 0, -1000, -1000, -HOUR, -25 * HOUR, -8 * 24 * HOUR]; // many collisions

    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(reqJson(`e${i}`, new Date(NOW + pick(tsPool)).toISOString(), {
        mcp: pick(mcps), category: pick(CATS), severity: pick(SEVS),
      }));
    }
    // Split across a few files.
    await writeFile(join(dir, '01A.jsonl'), lines.slice(0, 150).join('\n') + '\n');
    await writeFile(join(dir, '01B.jsonl'), lines.slice(150, 300).join('\n') + '\n');
    await writeFile(join(dir, '01C.jsonl'), lines.slice(300).join('\n') + '\n');

    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const auditEvents = (await readAudit(dir, NOW)).events;

    const filters: DetectionFilter[] = [
      ALL,
      { ...ALL, mcp: 'notion' },
      { ...ALL, timeRange: '24h' },
      { ...ALL, timeRange: '1h', severities: ['critical', 'high'] },
      { ...ALL, categories: ['tool_call_allowed', 'pii_detected'] },
    ];

    for (const filter of filters) {
      const expected = referenceIds(auditEvents, filter, NOW);
      // Walk the store in pages of 7.
      const walked: string[] = [];
      let cursor: DetectionCursor | null = null;
      for (;;) {
        const p = await store.getPage({ filter, limit: 7, cursor });
        walked.push(...p.rows.map((r) => r.id));
        expect(p.totalMatching).toBe(expected.length);
        if (p.nextCursor === null) break;
        cursor = p.nextCursor;
      }
      expect(walked).toEqual(expected);
    }
  });
});

describe('toSlim', () => {
  it('drops enrichment/heavy fields, keeps presentation fields', () => {
    const e = req('a', new Date(NOW).toISOString(), { args: { x: 1 } });
    const slim = toSlim(e);
    expect(slim).toEqual({
      id: 'a', ts: new Date(NOW).toISOString(), mcp: 'm', type: 'mcp.request',
      category: 'tool_call_allowed', severity: 'low', toolName: 'echo', method: 'tools/call',
    });
  });
});
