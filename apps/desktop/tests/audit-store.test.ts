import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuditStore } from '../src/main/audit-store.js';
import { readAudit } from '../src/main/detection-reader.js';
import { runSweep } from '../src/main/retention.js';
import type { DetectionListResult } from '../src/shared/types.js';

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offset = 0): string => new Date(NOW + offset).toISOString();

function reqLine(id: string, ts: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1, id, ts, session: 'sess', mcp: 'test-mcp', type: 'mcp.request',
    direction: 'client_to_server', rpcId: 1, method: 'tools/call',
    params: { name: 'echo' }, bytes: 100, overheadUs: 50,
    detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
    ...over,
  });
}
function enrLine(id: string, ts: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1, id, ts, session: 'sess', mcp: 'test-mcp', type: 'mcp.detection_enrichment',
    rpcId: 1, direction: 'client_to_server',
    detection: { category: 'pii_detected', severity: 'medium', findings: [{ type: 'email', location: 'p' }] },
    ...over,
  });
}
function oauthLine(id: string, mcp: string, ts: string, message = 'reauth'): string {
  return JSON.stringify({ v: 1, id, ts, session: 's', mcp, type: 'proxy.error', kind: 'oauth_failed', message });
}
function recoveredLine(id: string, mcp: string, ts: string): string {
  return JSON.stringify({ v: 1, id, ts, session: 'desktop', mcp, type: 'app.connector_recovered' });
}
function responseLine(id: string, mcp: string, ts: string): string {
  return JSON.stringify({ v: 1, id, ts, session: 's', mcp, type: 'mcp.response', direction: 'server_to_client', rpcId: 1, bytes: 10 });
}

const ids = (r: DetectionListResult): string[] => r.events.map((e) => e.id);
const enrichmentCat = (e: DetectionListResult['events'][number]): string | null =>
  e.type === 'mcp.request' ? e.enrichment?.category ?? null : null;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xcg-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AuditStore — incremental append', () => {
  it('reads a file from 0, then only the new bytes on growth', async () => {
    const reads: Array<[string, number, number]> = [];
    const store = createAuditStore(dir, {
      minRefreshMs: 0, now: () => NOW, onRead: (n, f, t) => reads.push([n, f, t]),
    });
    const c1 = reqLine('a', iso()) + '\n' + reqLine('b', iso(1)) + '\n';
    const size1 = Buffer.byteLength(c1, 'utf8');
    await writeFile(join(dir, '01A.jsonl'), c1);
    const r1 = await store.get();
    expect(ids(r1).sort()).toEqual(['a', 'b']);
    expect(reads).toEqual([['01A.jsonl', 0, size1]]);

    const c2 = reqLine('c', iso(2)) + '\n';
    await appendFile(join(dir, '01A.jsonl'), c2);
    const r2 = await store.get();
    expect(ids(r2).sort()).toEqual(['a', 'b', 'c']);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual(['01A.jsonl', size1, size1 + Buffer.byteLength(c2, 'utf8')]);
  });

  it('holds a partial trailing line in pendingTail until it completes', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const line1 = reqLine('a', iso()) + '\n';
    const line2 = reqLine('b', iso(1)) + '\n';
    const half = line2.slice(0, 12); // no newline yet
    await writeFile(join(dir, 'p.jsonl'), line1 + half);
    expect(ids(await store.get())).toEqual(['a']); // partial b excluded

    await appendFile(join(dir, 'p.jsonl'), line2.slice(12)); // finish the line
    expect(ids(await store.get()).sort()).toEqual(['a', 'b']);
  });

  it('picks up a brand-new file appearing mid-sequence', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    expect(ids(await store.get())).toEqual(['a']);
    await writeFile(join(dir, 'b.jsonl'), reqLine('b', iso()) + '\n');
    expect(ids(await store.get()).sort()).toEqual(['a', 'b']);
  });

  it('does not re-read an unchanged file', async () => {
    const reads: Array<[string, number, number]> = [];
    const store = createAuditStore(dir, {
      minRefreshMs: 0, now: () => NOW, onRead: (n, f, t) => reads.push([n, f, t]),
    });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    await store.get();
    expect(reads).toHaveLength(1);
    await store.get(); // refresh runs, but no bytes changed
    expect(reads).toHaveLength(1);
  });
});

describe('AuditStore — invalidation', () => {
  it('drops a vanished file (purge / manual delete)', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    await writeFile(join(dir, 'b.jsonl'), reqLine('b', iso()) + '\n');
    expect(ids(await store.get()).sort()).toEqual(['a', 'b']);
    await unlink(join(dir, 'a.jsonl'));
    expect(ids(await store.get())).toEqual(['b']);
  });

  it('full re-reads a truncated file (size < offset)', async () => {
    const reads: Array<[string, number, number]> = [];
    const store = createAuditStore(dir, {
      minRefreshMs: 0, now: () => NOW, onRead: (n, f, t) => reads.push([n, f, t]),
    });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n' + reqLine('b', iso(1)) + '\n');
    expect(ids(await store.get()).sort()).toEqual(['a', 'b']);
    // Rewrite shorter (drop b): size shrinks below the cached offset.
    const shorter = reqLine('a', iso()) + '\n';
    await writeFile(join(dir, 'a.jsonl'), shorter);
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 10_000), new Date(NOW + 10_000));
    expect(ids(await store.get())).toEqual(['a']);
    // The last read was a full re-read from offset 0.
    expect(reads[reads.length - 1]).toEqual(['a.jsonl', 0, Buffer.byteLength(shorter, 'utf8')]);
  });

  it('full re-reads a same-length rewrite when mtime changed', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    const a = reqLine('aaaa', iso()) + '\n';
    const b = reqLine('bbbb', iso()) + '\n';
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b)); // identical length
    await writeFile(join(dir, 'a.jsonl'), a);
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 1000), new Date(NOW + 1000));
    expect(ids(await store.get())).toEqual(['aaaa']);
    await writeFile(join(dir, 'a.jsonl'), b);
    await utimes(join(dir, 'a.jsonl'), new Date(NOW + 2000), new Date(NOW + 2000));
    expect(ids(await store.get())).toEqual(['bbbb']);
  });

  it('skips an unreadable entry (a directory named *.jsonl) and keeps the rest', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'good.jsonl'), reqLine('a', iso()) + '\n');
    await mkdir(join(dir, 'bad.jsonl'));
    expect(ids(await store.get())).toEqual(['a']);
  });
});

describe('AuditStore — correlation & no-mutation', () => {
  it('correlates an enrichment that arrives in a later poll', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    let r = await store.get();
    expect(ids(r)).toEqual(['a']);
    expect(enrichmentCat(r.events[0]!)).toBeNull();

    await appendFile(join(dir, 'a.jsonl'), enrLine('e', iso(1)) + '\n'); // same (session,rpcId,direction)
    r = await store.get();
    expect(ids(r)).toEqual(['a']);
    expect(enrichmentCat(r.events[0]!)).toBe('pii_detected');
  });

  it('never mutates cached events: removing the enrichment file clears the join', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n'); // request
    await writeFile(join(dir, 'b.jsonl'), enrLine('e', iso(1)) + '\n'); // enrichment (matches)
    let r = await store.get();
    expect(enrichmentCat(r.events.find((e) => e.id === 'a')!)).toBe('pii_detected');

    await unlink(join(dir, 'b.jsonl'));
    store.invalidate(['b.jsonl']);
    r = await store.get();
    expect(ids(r)).toEqual(['a']);
    // If entry.events had been mutated, the enrichment would still be attached.
    expect(enrichmentCat(r.events[0]!)).toBeNull();
  });

  it('sorts the accumulated set by ts descending across polls', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('mid', iso(0)) + '\n');
    await store.get();
    await appendFile(
      join(dir, 'a.jsonl'),
      reqLine('early', iso(-HOUR)) + '\n' + reqLine('late', iso(HOUR)) + '\n',
    );
    expect(ids(await store.get())).toEqual(['late', 'mid', 'early']);
  });
});

describe('AuditStore — coalescing', () => {
  it('returns the cached result within the refresh window (no disk read)', async () => {
    let mono = 1000;
    const reads: unknown[] = [];
    const store = createAuditStore(dir, {
      minRefreshMs: 1000, now: () => NOW, monotonic: () => mono,
      onRead: (n, f, t) => reads.push([n, f, t]),
    });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    const r1 = await store.get();
    expect(reads).toHaveLength(1);
    const r2 = await store.get(); // within window
    expect(reads).toHaveLength(1);
    expect(r2).toBe(r1); // same cached reference

    mono = 3000; // past the window
    await appendFile(join(dir, 'a.jsonl'), reqLine('b', iso(1)) + '\n');
    const r3 = await store.get();
    expect(reads).toHaveLength(2);
    expect(ids(r3).sort()).toEqual(['a', 'b']);
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    const p1 = store.get();
    const p2 = store.get(); // before p1 resolves
    expect(p1).toBe(p2);
    await p1;
  });
});

describe('AuditStore — early-exit (assemble TTL)', () => {
  it('within TTL and unchanged: reuses event objects (early-exit) but recomputes authAlerts on a new now()', async () => {
    let mono = 0;
    let authNow = NOW;
    const store = createAuditStore(dir, {
      minRefreshMs: 0,
      assembleTtlMs: 60_000,
      now: () => authNow,
      monotonic: () => mono,
    });
    // One request (drives events identity) + one oauth_failed 12h before NOW
    // (drives an authAlert that ages out of the 24h window as now() advances).
    await writeFile(
      join(dir, 'a.jsonl'),
      reqLine('a', iso()) + '\n' + oauthLine('f', 'notion', iso(-12 * HOUR)) + '\n',
    );

    const r1 = await store.get();
    expect(ids(r1)).toEqual(['a']);
    expect(r1.authAlerts.map((x) => x.mcp)).toEqual(['notion']); // fail 12h ago → alerting

    // No filesystem change; advance the TTL clock a little (< TTL) and push
    // now() past the 24h window (fail at NOW-12h; NOW+13h is 25h later).
    mono = 1000;
    authNow = NOW + 13 * HOUR;
    const r2 = await store.get();

    // Early-exit took: the event OBJECTS are the SAME references. A full
    // assembleAudit would have produced fresh {...req} copies with new identity.
    expect(r2.events[0]).toBe(r1.events[0]);
    // authAlerts, however, were recomputed against the new now(): the fail is
    // now > 24h old, so the alert is gone — the time-dependent part is NOT
    // frozen by the early-exit.
    expect(r2.authAlerts).toEqual([]);
  });

  it('a filesystem change bypasses the early-exit: assembleAudit runs and events change', async () => {
    let mono = 0;
    const store = createAuditStore(dir, {
      minRefreshMs: 0,
      assembleTtlMs: 60_000,
      now: () => NOW,
      monotonic: () => mono,
    });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    const r1 = await store.get();
    expect(ids(r1)).toEqual(['a']);

    // Append a new event within the TTL → signature changes → no early-exit.
    mono = 1000;
    await appendFile(join(dir, 'a.jsonl'), reqLine('b', iso(1)) + '\n');
    const r2 = await store.get();
    expect(ids(r2).sort()).toEqual(['a', 'b']); // new event present
    // Full re-assemble → fresh copies: the 'a' object identity differs.
    const a1 = r1.events.find((e) => e.id === 'a')!;
    const a2 = r2.events.find((e) => e.id === 'a')!;
    expect(a2).not.toBe(a1);
  });

  it('TTL expiry forces a re-assemble even when nothing changed (content equal, fresh objects)', async () => {
    let mono = 0;
    const store = createAuditStore(dir, {
      minRefreshMs: 0,
      assembleTtlMs: 60_000,
      now: () => NOW,
      monotonic: () => mono,
    });
    await writeFile(join(dir, 'a.jsonl'), reqLine('a', iso()) + '\n');
    const r1 = await store.get();
    expect(ids(r1)).toEqual(['a']);

    // No change, but advance past the TTL → early-exit not taken; re-assemble.
    mono = 60_001;
    const r2 = await store.get();
    expect(ids(r2)).toEqual(['a']); // same content
    expect(r2.events[0]).not.toBe(r1.events[0]); // fresh object → re-assembled
  });
});

describe('AuditStore — retention sweep integration', () => {
  it('drops purged sessions via invalidate() after a sweep unlinks them', async () => {
    const OLD_ULID = '01KRDWJ6Y9SYW2KQRTRZSX6ERT'; // decodeTime ≈ 2026-05-12
    const OLD_MS = 1778582625225;
    const store = createAuditStore(dir, { minRefreshMs: 10_000, now: () => NOW, monotonic: () => 5000 });
    // One old session (purgable) and one recent session (kept).
    await writeFile(join(dir, `${OLD_ULID}.jsonl`), reqLine('old', iso(-40 * DAY)) + '\n');
    await utimes(join(dir, `${OLD_ULID}.jsonl`), new Date(OLD_MS), new Date(OLD_MS));
    await writeFile(join(dir, 'recent.jsonl'), reqLine('recent', iso(-HOUR)) + '\n');
    expect(ids(await store.get()).sort()).toEqual(['old', 'recent']);

    const outcome = await runSweep(dir, { purgeMode: '30d', sizeWarnBytes: 1 }, OLD_MS + 100 * DAY, () => {});
    expect(outcome.purgedFiles).toEqual([`${OLD_ULID}.jsonl`]);
    expect(existsSync(join(dir, `${OLD_ULID}.jsonl`))).toBe(false);

    // invalidate() bypasses the (still-open) refresh window.
    store.invalidate(outcome.purgedFiles);
    expect(ids(await store.get())).toEqual(['recent']);
  });
});

// mulberry32 — small deterministic PRNG so the oracle is reproducible.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('AuditStore — golden oracle vs readAudit', () => {
  it('matches readAudit (events ids+order + authAlerts) over random op sequences', async () => {
    const rnd = mulberry32(0xc0ffee);
    const pick = (n: number): number => Math.floor(rnd() * n);
    const store = createAuditStore(dir, { minRefreshMs: 0, now: () => NOW });

    // In-memory model: each file's canonical content (complete lines only) and
    // how many bytes have been flushed to disk (a flush may cut mid-line).
    const files = new Map<string, { content: string; flushed: number }>();
    let idc = 0;
    let nameC = 0;
    let mtick = 0;
    const nextId = (): string => `ev${idc++}`;
    const mcps = ['notion', 'linear', 'stripe'];

    function randomLine(): string {
      const ts = iso(pick(48 * HOUR) - 24 * HOUR); // ±24h → auth-alert variety
      const mcp = mcps[pick(mcps.length)]!;
      switch (pick(5)) {
        case 0: return reqLine(nextId(), ts, { mcp });
        case 1: return enrLine(nextId(), ts, { mcp });
        case 2: return oauthLine(nextId(), mcp, ts);
        case 3: return recoveredLine(nextId(), mcp, ts);
        default: return responseLine(nextId(), mcp, ts);
      }
    }

    async function flush(name: string): Promise<void> {
      const f = files.get(name)!;
      const room = f.content.length - f.flushed;
      const target = f.flushed + (room > 0 ? pick(room + 1) : 0);
      f.flushed = target;
      await writeFile(join(dir, name), f.content.slice(0, target));
      mtick += 1;
      await utimes(join(dir, name), new Date(NOW + mtick), new Date(NOW + mtick));
    }

    async function assertMatch(): Promise<void> {
      const s = await store.get();
      const o = await readAudit(dir, NOW);
      const proj = (r: DetectionListResult): unknown[] =>
        r.events.map((e) => [e.id, e.type, enrichmentCat(e)]);
      expect(proj(s)).toEqual(proj(o));
      expect(s.authAlerts).toEqual(o.authAlerts);
    }

    for (let step = 0; step < 160; step++) {
      const names = [...files.keys()];
      const op = files.size === 0 ? 0 : pick(6);
      if (op === 0) {
        // create a new file
        const name = `f${nameC++}.jsonl`;
        files.set(name, { content: '', flushed: 0 });
        await writeFile(join(dir, name), '');
        mtick += 1;
        await utimes(join(dir, name), new Date(NOW + mtick), new Date(NOW + mtick));
      } else if (op === 1 || op === 2) {
        // append 1-3 complete lines to content, then flush (maybe partial)
        const name = names[pick(names.length)]!;
        const f = files.get(name)!;
        const n = 1 + pick(3);
        for (let i = 0; i < n; i++) f.content += randomLine() + '\n';
        await flush(name);
      } else if (op === 3) {
        // flush more of an existing file
        await flush(names[pick(names.length)]!);
      } else if (op === 4) {
        // rewrite shorter: keep a random prefix of complete lines
        const name = names[pick(names.length)]!;
        const f = files.get(name)!;
        const lines = f.content.length > 0 ? f.content.slice(0, -1).split('\n') : [];
        const keep = lines.length > 0 ? pick(lines.length) : 0;
        const newContent = keep > 0 ? lines.slice(0, keep).join('\n') + '\n' : '';
        f.content = newContent;
        f.flushed = newContent.length;
        await writeFile(join(dir, name), newContent);
        mtick += 1;
        await utimes(join(dir, name), new Date(NOW + mtick), new Date(NOW + mtick));
      } else {
        // delete a file
        const name = names[pick(names.length)]!;
        files.delete(name);
        await unlink(join(dir, name));
      }
      await assertMatch();
    }
  });
});
