import { appendFile, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { matchesFilter, paginate, toDetail, toSlim } from '../src/main/detection-page.js';
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
const ALL: DetectionFilter = {
  mcp: null, timeRange: 'all', categories: [...CATS], severities: [...SEVS],
  sources: ['gateway', 'claude-code'],
};

function req(
  id: string,
  ts: string,
  opts: { mcp?: string; category?: Category; severity?: Severity; args?: unknown; source?: string; toolName?: string; ccSession?: string; cwd?: string; argsSummary?: string; outcome?: 'ok' | 'error' } = {},
): EnrichableEvent {
  const e = {
    id, ts, session: 's', mcp: opts.mcp ?? 'm', type: 'mcp.request' as const,
    method: 'tools/call', rpcId: 1, direction: 'client_to_server' as const,
    toolName: opts.toolName ?? 'echo',
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.ccSession !== undefined ? { ccSession: opts.ccSession } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.argsSummary !== undefined ? { argsSummary: opts.argsSummary } : {}),
    ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
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
  const cutoff =
    filter.timeRange === 'all' || filter.timeRange === 'custom'
      ? null
      : now - WINDOW[filter.timeRange];
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
      toolName: 'echo', method: 'tools/call', source: 'gateway',
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

function reqJson(id: string, ts: string, opts: { mcp?: string; category?: Category; severity?: Severity; args?: unknown; source?: string; ccSession?: string; cwd?: string } = {}): string {
  return JSON.stringify({
    v: 1, id, ts, session: 's', mcp: opts.mcp ?? 'm', type: 'mcp.request',
    direction: 'client_to_server', rpcId: 1, method: 'tools/call',
    params: { name: 'echo', ...(opts.args !== undefined ? { arguments: opts.args } : {}) },
    bytes: 10, overheadUs: 7,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.ccSession !== undefined ? { ccSession: opts.ccSession } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
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
      source: 'gateway',
    });
  });

  it('CC provenance (F2.4): row carries ccSession and project = basename(cwd)', () => {
    const ts = new Date(NOW).toISOString();
    const cc = req('c', ts, {
      source: 'claude-code', ccSession: 'uuid-X', cwd: '/Users/user/proyecto-x',
    });
    const slim = toSlim(cc);
    expect(slim.ccSession).toBe('uuid-X');
    expect(slim.project).toBe('proyecto-x'); // basename, not the full path
    // Absent on non-CC rows (forward-only tolerance).
    const gw = toSlim(req('g', ts));
    expect(gw.ccSession).toBeUndefined();
    expect(gw.project).toBeUndefined();
  });

  it('argsSummary (F2.4 commit 3): copied to the row when present, absent otherwise', () => {
    const ts = new Date(NOW).toISOString();
    const withSummary = toSlim(req('s1', ts, { argsSummary: 'git status' }));
    expect(withSummary.argsSummary).toBe('git status');
    const without = toSlim(req('s2', ts));
    expect(without.argsSummary).toBeUndefined();
  });
});

describe('tool + ccSession filters (F2.4)', () => {
  const ts = new Date(NOW).toISOString();
  const echo = req('e1', ts); // toolName 'echo', no CC provenance
  const write = req('w1', ts, { toolName: 'Write' });
  const ccA = req('a1', ts, { source: 'claude-code', ccSession: 'uuid-A', toolName: 'Bash' });
  const ccB = req('b1', ts, { source: 'claude-code', ccSession: 'uuid-B', toolName: 'Bash' });
  // CC enrichment carrying ccSession (no toolName — enrichments never have one).
  const enrA = {
    id: 'n1', ts, session: 's', mcp: 'm', type: 'mcp.detection_enrichment' as const,
    rpcId: 1, direction: 'client_to_server' as const,
    source: 'claude-code', ccSession: 'uuid-A',
    detection: { category: 'pii_detected' as Category, severity: 'medium' as Severity, findings: [] },
  } as EnrichableEvent;
  const events = [echo, write, ccA, ccB, enrA];

  it('tool filter is multi-select membership; null, absent and [] mean no filter', () => {
    const p = paginate(events, { ...ALL, tool: ['Write'] }, 10, null, NOW);
    expect(p.rows.map((r) => r.id)).toEqual(['w1']);
    expect(p.totalMatching).toBe(1);
    // Two tools checked → both match (commit 6 multi-select).
    const multi = paginate(events, { ...ALL, tool: ['Write', 'Bash'] }, 10, null, NOW);
    expect(multi.rows.map((r) => r.id).sort()).toEqual(['a1', 'b1', 'w1']);
    // null ≡ absent ≡ [] ≡ ALL (backward compatible).
    const base = paginate(events, ALL, 10, null, NOW).totalMatching;
    expect(paginate(events, { ...ALL, tool: null }, 10, null, NOW).totalMatching).toBe(base);
    expect(paginate(events, { ...ALL, tool: [] }, 10, null, NOW).totalMatching).toBe(base);
  });

  it('an active tool filter excludes enrichment rows (they carry no toolName)', () => {
    const p = paginate(events, { ...ALL, tool: ['Bash'] }, 10, null, NOW);
    expect(p.rows.map((r) => r.id).sort()).toEqual(['a1', 'b1']); // n1 excluded
  });

  it('ccSession filter matches requests AND enrichments; wrapper events excluded', () => {
    const p = paginate(events, { ...ALL, ccSession: ['uuid-A'] }, 10, null, NOW);
    expect(p.rows.map((r) => r.id).sort()).toEqual(['a1', 'n1']);
    expect(p.totalMatching).toBe(2);
    // null ≡ absent.
    expect(paginate(events, { ...ALL, ccSession: null }, 10, null, NOW).totalMatching)
      .toBe(paginate(events, ALL, 10, null, NOW).totalMatching);
  });

  it('combines with sources: cc-only + ccSession picks exactly that session', () => {
    const p = paginate(
      events,
      { ...ALL, sources: ['claude-code'], ccSession: ['uuid-B'] },
      10, null, NOW,
    );
    expect(p.rows.map((r) => r.id)).toEqual(['b1']);
    // And with tool on top: cc-only + ccSession + tool narrows to the request.
    const q = paginate(
      events,
      { ...ALL, sources: ['claude-code'], ccSession: ['uuid-A'], tool: ['Bash'] },
      10, null, NOW,
    );
    expect(q.rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('project filter is server-side membership on basename(cwd) (commit 6)', () => {
    const withProj = req('p1', ts, {
      source: 'claude-code', ccSession: 'uuid-A', cwd: '/Users/user/proj-x', toolName: 'Read',
    });
    const p = paginate([...events, withProj], { ...ALL, project: ['proj-x'] }, 10, null, NOW);
    expect(p.rows.map((r) => r.id)).toEqual(['p1']);
    // null ≡ absent.
    expect(paginate([...events, withProj], { ...ALL, project: null }, 10, null, NOW).totalMatching)
      .toBe(paginate([...events, withProj], ALL, 10, null, NOW).totalMatching);
  });
});

describe('facets — stable inventories (commit 6)', () => {
  const ts = new Date(NOW).toISOString();
  const echo = req('e1', ts);
  const write = req('w1', ts, { toolName: 'Write' });
  const ccA = req('a1', ts, {
    source: 'claude-code', ccSession: 'uuid-A', toolName: 'Bash', cwd: '/Users/user/proj-a',
  });
  const ccB = req('b1', ts, { source: 'claude-code', ccSession: 'uuid-B', toolName: 'Bash' });
  const events = [echo, write, ccA, ccB];

  it("a facet's own selection never shrinks its inventory (the dogfood bug)", () => {
    // Filter narrowed to Bash: rows shrink, facets.tools must NOT.
    const p = paginate(events, { ...ALL, tool: ['Bash'] }, 10, null, NOW);
    expect(p.rows.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    expect(p.facets.tools).toEqual(['Bash', 'Write', 'echo']);
    // Same for ccSession and project under their own filters.
    const q = paginate(events, { ...ALL, ccSession: ['uuid-A'], project: ['proj-a'] }, 10, null, NOW);
    expect(q.facets.ccSessions.map((c) => c.id).sort()).toEqual(['uuid-A', 'uuid-B']);
    expect(q.facets.projects).toEqual(['proj-a']);
  });

  it('facets DO respect the base filter: sources and timeRange', () => {
    // cc-only source → gateway tools (echo/Write) leave the inventory.
    const p = paginate(events, { ...ALL, sources: ['claude-code'] }, 10, null, NOW);
    expect(p.facets.tools).toEqual(['Bash']);
    // Time window excludes everything (events are at NOW; window ends before).
    const old = paginate(events, { ...ALL, timeRange: '1h' }, 10, null, NOW + 2 * 60 * 60 * 1000);
    expect(old.facets.tools).toEqual([]);
  });

  it('facets ignore categories/severities (only sources+timeRange are the base)', () => {
    const p = paginate(events, { ...ALL, severities: [], categories: [] }, 10, null, NOW);
    expect(p.rows).toEqual([]);
    expect(p.facets.tools).toEqual(['Bash', 'Write', 'echo']);
  });
});

describe('source survives the REAL detection:page path — JSONL → store cache → page (F1.3c-fix)', () => {
  it('slim rows carry source, cc-only filter returns exactly the cc line, incremental poll keeps it', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const ts = new Date(NOW).toISOString();
    await writeFile(
      join(dir, 'a.jsonl'),
      `${reqJson('gw1', ts)}\n${reqJson('cc1', ts, { mcp: 'claude-code', source: 'claude-code' })}\n`,
    );

    // Badge-data present on the slim rows (this is what DetectionRow renders).
    const all = await store.getPage({ filter: ALL, limit: 10, cursor: null });
    const byId = new Map(all.rows.map((r) => [r.id, r.source]));
    expect(byId.get('gw1')).toBe('gateway');
    expect(byId.get('cc1')).toBe('claude-code');

    // cc-only filter through the real store path returns exactly the cc line.
    const ccOnly = await store.getPage({
      filter: { ...ALL, sources: ['claude-code'] },
      limit: 10,
      cursor: null,
    });
    expect(ccOnly.rows.map((r) => r.id)).toEqual(['cc1']);
    expect(ccOnly.totalMatching).toBe(1);

    // Incremental append + second poll: the appended-lines path re-enters the
    // slim cache — the field must survive there too, and cached rows stay right.
    await appendFile(
      join(dir, 'a.jsonl'),
      `${reqJson('cc2', new Date(NOW + 1000).toISOString(), { source: 'claude-code' })}\n`,
    );
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 5000), new Date(NOW + 5000));
    const second = await store.getPage({
      filter: { ...ALL, sources: ['claude-code'] },
      limit: 10,
      cursor: null,
    });
    expect(second.rows.map((r) => r.id)).toEqual(['cc2', 'cc1']);
    expect(second.rows.every((r) => r.source === 'claude-code')).toBe(true);
  });
});

describe('ccSession/cwd survive the REAL detection:page path — JSONL → store cache → page (F2.4)', () => {
  it('slim rows carry ccSession+project, ccSession filter works via the store, incremental poll keeps them', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const ts = new Date(NOW).toISOString();
    await writeFile(
      join(dir, 'a.jsonl'),
      `${reqJson('gw1', ts)}\n` +
        `${reqJson('cc1', ts, { source: 'claude-code', ccSession: 'uuid-A', cwd: '/Users/user/proj-a', args: { q: 'consulta' } })}\n` +
        `${reqJson('cc2', ts, { source: 'claude-code', ccSession: 'uuid-B', cwd: '/Users/user/proj-b' })}\n`,
    );

    // The slim cache must retain ccSession/cwd/argsSummary (the F1.3c scar:
    // dropping them in slimEvent breaks silently — rows would lose the fields
    // and the ccSession filter would return nothing).
    const all = await store.getPage({ filter: ALL, limit: 10, cursor: null });
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(byId.get('cc1')?.ccSession).toBe('uuid-A');
    expect(byId.get('cc1')?.project).toBe('proj-a');
    // argsSummary derived at parse (summarizeArgs: first string value of
    // arguments) and survives slim cache → page row.
    expect(byId.get('cc1')?.argsSummary).toBe('consulta');
    expect(byId.get('cc2')?.project).toBe('proj-b');
    expect(byId.get('cc2')?.argsSummary).toBeUndefined();
    expect(byId.get('gw1')?.ccSession).toBeUndefined();
    expect(byId.get('gw1')?.project).toBeUndefined();

    // ccSession filter through the real store path.
    const onlyA = await store.getPage({
      filter: { ...ALL, ccSession: ['uuid-A'] },
      limit: 10,
      cursor: null,
    });
    expect(onlyA.rows.map((r) => r.id)).toEqual(['cc1']);
    expect(onlyA.totalMatching).toBe(1);

    // Incremental append re-enters the slim cache — fields must survive there too.
    await appendFile(
      join(dir, 'a.jsonl'),
      `${reqJson('cc3', new Date(NOW + 1000).toISOString(), { source: 'claude-code', ccSession: 'uuid-A', cwd: '/Users/user/proj-a' })}\n`,
    );
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 5000), new Date(NOW + 5000));
    const second = await store.getPage({
      filter: { ...ALL, ccSession: ['uuid-A'] },
      limit: 10,
      cursor: null,
    });
    expect(second.rows.map((r) => r.id)).toEqual(['cc3', 'cc1']);
    expect(second.rows[0]?.project).toBe('proj-a');
  });
});

describe('source filter (F1.3b)', () => {
  const ts = new Date(NOW).toISOString();
  const gw = req('gw', ts); // wrapper line: no source field at all
  const cc = req('cc', ts, { source: 'claude-code' });

  it('matchesFilter respects sources: gateway-only, claude-code-only, both', () => {
    expect(matchesFilter(gw, { ...ALL, sources: ['gateway'] }, NOW)).toBe(true);
    expect(matchesFilter(cc, { ...ALL, sources: ['gateway'] }, NOW)).toBe(false);
    expect(matchesFilter(gw, { ...ALL, sources: ['claude-code'] }, NOW)).toBe(false);
    expect(matchesFilter(cc, { ...ALL, sources: ['claude-code'] }, NOW)).toBe(true);
    expect(matchesFilter(gw, ALL, NOW)).toBe(true);
    expect(matchesFilter(cc, ALL, NOW)).toBe(true);
  });

  it("missing source field normalizes to 'gateway'; any non-'claude-code' value too", () => {
    expect(toSlim(gw).source).toBe('gateway');
    expect(toSlim(req('odd', ts, { source: 'something-else' })).source).toBe('gateway');
  });

  it('toSlim and toDetail copy the normalized source', () => {
    expect(toSlim(cc).source).toBe('claude-code');
    expect(toDetail(cc).source).toBe('claude-code');
    expect(toDetail(gw).source).toBe('gateway');
  });
});

describe('delta final — text, status, custom range, session facet meta', () => {
  const ts = new Date(NOW).toISOString();
  const bash = req('t1', ts, { toolName: 'Bash', argsSummary: 'git push origin', outcome: 'ok' });
  const read = req('t2', ts, { toolName: 'Read', argsSummary: 'apps/x.ts', outcome: 'error' });
  const orphan = req('t3', ts, { toolName: 'Write' }); // no outcome
  const events = [bash, read, orphan];

  it('text: case-insensitive against toolName and argsSummary; export inherits via matchesFilter', () => {
    expect(paginate(events, { ...ALL, text: 'PUSH' }, 10, null, NOW).rows.map((r) => r.id)).toEqual(['t1']);
    expect(paginate(events, { ...ALL, text: 'bash' }, 10, null, NOW).rows.map((r) => r.id)).toEqual(['t1']);
    expect(paginate(events, { ...ALL, text: 'x.ts' }, 10, null, NOW).rows.map((r) => r.id)).toEqual(['t2']);
    expect(paginate(events, { ...ALL, text: 'nomatch' }, 10, null, NOW).rows).toEqual([]);
    // matchesFilter IS the export predicate — text applies there too.
    expect(matchesFilter(bash, { ...ALL, text: 'push' }, NOW)).toBe(true);
    expect(matchesFilter(read, { ...ALL, text: 'push' }, NOW)).toBe(false);
  });

  it('status: ok/error membership; orphan requests match NO active status filter', () => {
    expect(paginate(events, { ...ALL, status: ['ok'] }, 10, null, NOW).rows.map((r) => r.id)).toEqual(['t1']);
    expect(paginate(events, { ...ALL, status: ['error'] }, 10, null, NOW).rows.map((r) => r.id)).toEqual(['t2']);
    // Both statuses selected still excludes the orphan (it is neither).
    expect(
      paginate(events, { ...ALL, status: ['ok', 'error'] }, 10, null, NOW).rows.map((r) => r.id).sort(),
    ).toEqual(['t1', 't2']);
    // null ≡ absent ≡ [] → all three.
    expect(paginate(events, { ...ALL, status: null }, 10, null, NOW).totalMatching).toBe(3);
  });

  it('outcome rides the slim row (error dot data)', () => {
    const p = paginate(events, ALL, 10, null, NOW);
    const byId = new Map(p.rows.map((r) => [r.id, r]));
    expect(byId.get('t1')?.outcome).toBe('ok');
    expect(byId.get('t2')?.outcome).toBe('error');
    expect(byId.get('t3')?.outcome).toBeUndefined();
  });

  it('custom range: explicit from/to, inclusive both ends', () => {
    const july1 = req('d1', '2026-07-01T10:00:00.000Z');
    const july15 = req('d2', '2026-07-15T10:00:00.000Z');
    const july20 = req('d3', '2026-07-20T23:30:00.000Z');
    const all = [july1, july15, july20];
    const p = paginate(
      all,
      { ...ALL, timeRange: 'custom', customRange: { from: '2026-07-10', to: '2026-07-20' } },
      10, null, NOW,
    );
    expect(p.rows.map((r) => r.id).sort()).toEqual(['d2', 'd3']); // d3: same-day inclusive
    // Missing range while timeRange=custom → no restriction (transitional UI state).
    expect(
      paginate(all, { ...ALL, timeRange: 'custom', customRange: null }, 10, null, NOW).totalMatching,
    ).toBe(3);
  });

  it('session facet meta: started=min ts, where=most recent project (mcp fallback), recent-first', () => {
    const sA1 = req('a1', '2026-07-02T10:00:00.000Z', { source: 'claude-code', ccSession: 'uuid-A', mcp: 'claude-code' });
    const sA2 = req('a2', '2026-07-02T11:00:00.000Z', { source: 'claude-code', ccSession: 'uuid-A', cwd: '/Users/user/proj-a' });
    const sB = req('b1', '2026-07-02T11:30:00.000Z', { source: 'claude-code', ccSession: 'uuid-B', mcp: 'xcg-toy' });
    const p = paginate([sA1, sA2, sB], ALL, 10, null, NOW);
    // Recent-first by started: B (11:30) then A (10:00).
    expect(p.facets.ccSessions.map((c) => c.id)).toEqual(['uuid-B', 'uuid-A']);
    const a = p.facets.ccSessions.find((c) => c.id === 'uuid-A')!;
    expect(a.started).toBe('2026-07-02T10:00:00.000Z'); // min observed
    expect(a.where).toBe('proj-a'); // project wins over mcp
    const b = p.facets.ccSessions.find((c) => c.id === 'uuid-B')!;
    expect(b.where).toBe('xcg-toy'); // mcp fallback (no cwd in session)
  });
});

describe('outcome backfill through the store (delta final — long-running tool)', () => {
  it('a response landing in a LATER chunk backfills the cached request', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const ts = new Date(NOW).toISOString();
    // Chunk 1: request only (long-running tool still executing).
    await writeFile(join(dir, 'a.jsonl'), reqJson('slow1', ts) + '\n');
    const first = await store.getPage({ filter: ALL, limit: 10, cursor: null });
    expect(first.rows[0]?.outcome).toBeUndefined();

    // Chunk 2: the error response arrives in a later append.
    const resp = JSON.stringify({
      v: 1, id: 'resp1', ts: new Date(NOW + 30_000).toISOString(), session: 's', mcp: 'm',
      type: 'mcp.response', direction: 'server_to_client', rpcId: 1, error: 'timeout',
    });
    await appendFile(join(dir, 'a.jsonl'), resp + '\n');
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 31_000), new Date(NOW + 31_000));
    const second = await store.getPage({ filter: ALL, limit: 10, cursor: null });
    expect(second.rows.find((r) => r.id === 'slow1')?.outcome).toBe('error');
    // And the status filter sees it through the real path.
    const errs = await store.getPage({ filter: { ...ALL, status: ['error'] }, limit: 10, cursor: null });
    expect(errs.rows.map((r) => r.id)).toEqual(['slow1']);
  });
});
