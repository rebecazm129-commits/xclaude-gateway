// Tests for the Claude Code spool ingester (F1.2): fs orchestration over temp
// dirs (order, idempotence, append+unlink, unreadable skip, stable session
// map), the auth-signal source guard in the reader, and the ORACLE — after
// ingesting the real fixtures, the REAL AuditStore lists the events cleanly.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';

import {
  getCchookStatus,
  resetCchookStatusForTests,
  runCchookIngestCycle,
} from '../src/main/cchook-ingester.js';
import { parseAuditContent } from '../src/main/detection-reader.js';
import { createAuditStore } from '../src/main/audit-store.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../packages/proxy/tests/fixtures/cchook/', import.meta.url),
);

interface TempDirs {
  base: string;
  spoolDir: string;
  wrappersDir: string;
}

const allTemp: string[] = [];
function makeDirs(): TempDirs {
  const base = mkdtempSync(join(tmpdir(), 'xcg-cchook-ingester-'));
  allTemp.push(base);
  const spoolDir = join(base, 'spool');
  const wrappersDir = join(base, 'wrappers');
  mkdirSync(spoolDir, { recursive: true });
  return { base, spoolDir, wrappersDir };
}

function spoolWrite(spoolDir: string, seedTime: number, content: string | Buffer): string {
  const id = ulid(seedTime);
  writeFileSync(join(spoolDir, `${id}.json`), content);
  return id;
}

function paths(d: TempDirs): { spoolDir: string; wrappersDir: string; stateDir: string } {
  return { spoolDir: d.spoolDir, wrappersDir: d.wrappersDir, stateDir: d.base };
}

function wrapperLines(d: TempDirs): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!existsSync(d.wrappersDir)) return out;
  for (const f of readdirSync(d.wrappersDir)) {
    for (const line of readFileSync(join(d.wrappersDir, f), 'utf8').split('\n')) {
      if (line.trim() !== '') out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

const fixture = (name: string): Buffer => readFileSync(join(FIXTURE_DIR, name));

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetCchookStatusForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of allTemp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runCchookIngestCycle', () => {
  it('processes spool files in ULID order, appends to the session trail and unlinks', async () => {
    const d = makeDirs();
    // Written "newest first" on disk; ULID seeds enforce the logical order.
    spoolWrite(d.spoolDir, 2_000, fixture('09-mcp.json'));
    spoolWrite(d.spoolDir, 1_000, fixture('05-write.json'));

    const res = await runCchookIngestCycle(paths(d));
    expect(res).toEqual({ processed: 2, skippedUnreadable: 0, deletedStale: 0 });
    expect(readdirSync(d.spoolDir)).toEqual([]); // drained

    const lines = wrapperLines(d);
    expect(lines).toHaveLength(4); // two request/response pairs
    // Oldest spool (05-write, seed 1000) lands first.
    const params0 = (lines[0] as { params?: { name?: string } }).params;
    expect(params0?.name).toBe('Write');
    // captureTime comes from the spool ULID (seed 1000 → response ts at epoch+1s).
    expect(lines[1]?.['ts']).toBe(new Date(1_000).toISOString());
    // Same cc session UUID → both pairs share ONE session file.
    expect(readdirSync(d.wrappersDir)).toHaveLength(1);
  });

  it('idempotence: spool ULID ≤ lastProcessed is deleted WITHOUT reprocessing', async () => {
    const d = makeDirs();
    const staleId = spoolWrite(d.spoolDir, 1_000, fixture('05-write.json'));
    // Simulate a crash that persisted state but not the unlink.
    writeFileSync(
      join(d.base, 'ingest-state.json'),
      JSON.stringify({ lastProcessedSpoolUlid: staleId }),
      { mode: 0o600 },
    );

    const res = await runCchookIngestCycle(paths(d));
    expect(res).toEqual({ processed: 0, skippedUnreadable: 0, deletedStale: 1 });
    expect(readdirSync(d.spoolDir)).toEqual([]);
    expect(wrapperLines(d)).toHaveLength(0); // nothing appended
  });

  it('unreadable spool entry: console.error, skipped, NOT deleted; the rest proceeds', async () => {
    const d = makeDirs();
    const dirAsFile = `${ulid(1_000)}.json`;
    mkdirSync(join(d.spoolDir, dirAsFile)); // readFile → EISDIR
    spoolWrite(d.spoolDir, 2_000, fixture('11-subagent-bash.json'));

    const res = await runCchookIngestCycle(paths(d));
    expect(res.processed).toBe(1);
    expect(res.skippedUnreadable).toBe(1);
    expect(readdirSync(d.spoolDir)).toEqual([dirAsFile]); // survives for retry
    expect(errSpy).toHaveBeenCalled();
  });

  it('session map UUID→ULID is stable across cycles (one trail per cc session)', async () => {
    const d = makeDirs();
    spoolWrite(d.spoolDir, 1_000, fixture('05-write.json'));
    await runCchookIngestCycle(paths(d));
    const filesAfterFirst = readdirSync(d.wrappersDir);
    const mapAfterFirst = JSON.parse(readFileSync(join(d.base, 'sessions.json'), 'utf8')) as Record<string, string>;

    spoolWrite(d.spoolDir, 2_000, fixture('09-mcp.json')); // same session UUID
    await runCchookIngestCycle(paths(d));

    expect(readdirSync(d.wrappersDir)).toEqual(filesAfterFirst); // same single file
    const mapAfterSecond = JSON.parse(readFileSync(join(d.base, 'sessions.json'), 'utf8')) as Record<string, string>;
    expect(mapAfterSecond).toEqual(mapAfterFirst);
    expect(wrapperLines(d)).toHaveLength(4); // one request/response pair per fixture
  });
});

describe('getCchookStatus (F1.3c)', () => {
  it('cycles update lastCycle and accumulate unreadableTotal', async () => {
    expect(getCchookStatus()).toEqual({ lastCycle: null, unreadableTotal: 0, lastSessionStartTs: null });

    const d = makeDirs();
    // The unreadable entry is the NEWEST (seed 3000 > 2000) so it stays above
    // the watermark and each cycle genuinely retries the read. An unreadable
    // entry BELOW the watermark hits the accepted third window instead
    // (deleted unprocessed — see the idempotence comment in the ingester).
    spoolWrite(d.spoolDir, 2_000, fixture('05-write.json'));
    mkdirSync(join(d.spoolDir, `${ulid(3_000)}.json`)); // unreadable (EISDIR)
    await runCchookIngestCycle(paths(d));

    const first = getCchookStatus();
    expect(first.lastCycle).toMatchObject({ processed: 1, skippedUnreadable: 1, deletedStale: 0 });
    expect(typeof first.lastCycle?.ts).toBe('string');
    expect(first.unreadableTotal).toBe(1);

    // Second cycle: still above the watermark → retried, accumulates.
    await runCchookIngestCycle(paths(d));
    const second = getCchookStatus();
    expect(second.lastCycle).toMatchObject({ processed: 0, skippedUnreadable: 1 });
    expect(second.unreadableTotal).toBe(2);
  });

  it('a SessionStart capture sets the heartbeat (capture time from the spool ULID) and persists it', async () => {
    const d = makeDirs();
    spoolWrite(d.spoolDir, 5_000, fixture('01-sessionstart.json'));
    await runCchookIngestCycle(paths(d));

    expect(getCchookStatus().lastSessionStartTs).toBe(new Date(5_000).toISOString());
    // Rides the same ingest-state.json write the cycle already does.
    const state = JSON.parse(readFileSync(join(d.base, 'ingest-state.json'), 'utf8')) as Record<string, unknown>;
    expect(state['lastSessionStartTs']).toBe(new Date(5_000).toISOString());
    // A non-SessionStart capture later does NOT move the heartbeat.
    spoolWrite(d.spoolDir, 9_000, fixture('05-write.json'));
    await runCchookIngestCycle(paths(d));
    expect(getCchookStatus().lastSessionStartTs).toBe(new Date(5_000).toISOString());
  });
});

describe('auth-signal source guard (detection-reader)', () => {
  const base = {
    v: 1,
    id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    ts: '2026-07-15T10:00:00.000Z',
    session: 'S',
    mcp: 'notion',
    type: 'mcp.request',
    direction: 'client_to_server',
    rpcId: 'r1',
    method: 'tools/call',
    params: { name: 't', arguments: {} },
    detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
  };

  it("synthesized line (source: 'claude-code') does NOT produce a live signal", () => {
    const { authSignals } = parseAuditContent(`${JSON.stringify({ ...base, source: 'claude-code' })}\n`);
    expect(authSignals).toEqual([]);
  });

  it('wrapper line without source DOES produce a live signal', () => {
    const { authSignals } = parseAuditContent(`${JSON.stringify(base)}\n`);
    expect(authSignals).toEqual([{ mcp: 'notion', ts: base.ts, kind: 'live' }]);
  });
});

describe('oracle: the real AuditStore reads the ingested trail', () => {
  it('lists the synthesized events without errors, toolName derived, no auth alerts', async () => {
    const d = makeDirs();
    let seed = 1_000;
    for (const name of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
      spoolWrite(d.spoolDir, (seed += 1_000), fixture(name));
    }
    const res = await runCchookIngestCycle(paths(d));
    expect(res.processed).toBe(5);

    const store = createAuditStore(d.wrappersDir, { minRefreshMs: 0 });
    const listed = await store.get();

    // 4 tool fixtures → 4 mcp.request rows with baseline detection; the
    // SessionStart cc.event is ignored by the reader without breaking.
    const requests = listed.events.filter(
      (e) => (e as unknown as Record<string, unknown>)['type'] === 'mcp.request',
    );
    expect(requests).toHaveLength(4);
    const toolNames = requests
      .map((e) => (e as unknown as Record<string, unknown>)['toolName'])
      .sort();
    expect(toolNames).toEqual(['Bash', 'Bash', 'Write', 'list_directory']);
    for (const r of requests) {
      const detection = (r as unknown as Record<string, unknown>)['detection'] as Record<string, unknown>;
      expect(detection['category']).toBe('tool_call_allowed');
    }
    // Guard holds end-to-end: no live signals → no relogin alerts from cc traffic.
    expect(listed.authAlerts).toEqual([]);
  });
});
