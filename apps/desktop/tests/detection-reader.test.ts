import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAudit, readDetections, readLatestToolCount } from '../src/main/detection-reader.js';
import { SELFTEST_WRAPPER_NAME } from '../src/main/selftest-runner.js';
import { CONNECTOR_RECOVERED_TYPE } from '../src/main/recovery-writer.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function baseEvent(id: string, ts: string): Record<string, unknown> {
  return {
    v: 1,
    id,
    ts,
    session: 'sess',
    mcp: 'test-mcp',
    type: 'mcp.request',
    direction: 'client_to_server',
    rpcId: 1,
    method: 'tools/call',
    params: {},
    bytes: 100,
    overheadUs: 50,
    detection: {
      category: 'tool_call_allowed',
      severity: 'low',
      findings: [],
    },
  };
}

function baseEnrichmentEvent(id: string, ts: string): Record<string, unknown> {
  return {
    v: 1,
    id,
    ts,
    session: 'sess',
    mcp: 'test-mcp',
    type: 'mcp.detection_enrichment',
    rpcId: 1,
    direction: 'client_to_server',
    detection: {
      category: 'pii_detected',
      severity: 'medium',
      findings: [{ type: 'email', location: 'params.email' }],
    },
  };
}

describe('readDetections', () => {
  it('returns [] when the directory does not exist', async () => {
    const result = await readDetections(join(tmpDir, 'does-not-exist'));
    expect(result).toEqual([]);
  });

  it('returns [] when the directory exists but has no JSONL files', async () => {
    const dir = join(tmpDir, 'empty');
    await mkdir(dir, { recursive: true });
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('skips non-jsonl files', async () => {
    const dir = join(tmpDir, 'mixed');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'foo.txt'), 'not jsonl');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('parses a valid detection event', async () => {
    const dir = join(tmpDir, 'valid');
    await mkdir(dir, { recursive: true });
    const event = baseEvent('e1', '2025-05-14T12:34:56.000Z');
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(event) + '\n');
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.detection.category).toBe('tool_call_allowed');
    expect(result[0]?.detection.severity).toBe('low');
  });

  it('skips events without a detection sub-object (e.g. mcp.response)', async () => {
    const dir = join(tmpDir, 'no-detection');
    await mkdir(dir, { recursive: true });
    const response = {
      v: 1, id: 'r1', ts: '2025-05-14T12:34:57.000Z', session: 's',
      mcp: 'm', type: 'mcp.response', direction: 'server_to_client',
      rpcId: 1, bytes: 200, overheadUs: 80,
    };
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(response) + '\n');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('skips malformed JSON lines silently', async () => {
    const dir = join(tmpDir, 'malformed');
    await mkdir(dir, { recursive: true });
    const valid = baseEvent('e1', '2025-05-14T12:00:00.000Z');
    await writeFile(
      join(dir, 's.jsonl'),
      'not json\n' + JSON.stringify(valid) + '\n{broken\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
  });

  it('skips an unreadable .jsonl entry (a directory named *.jsonl) and still returns the valid events', async () => {
    const dir = join(tmpDir, 'unreadable-file');
    await mkdir(dir, { recursive: true });
    const event = baseEvent('e1', '2025-05-14T12:34:56.000Z');
    await writeFile(join(dir, 'good.jsonl'), JSON.stringify(event) + '\n');
    // A directory whose name ends in .jsonl passes listJsonlFiles' filter,
    // but readFile throws EISDIR on it. readAudit must skip it and keep the
    // valid file's events rather than rejecting the whole read.
    await mkdir(join(dir, 'bad.jsonl'));
    const result = await readAudit(dir);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('e1');
  });

  it('sorts results by ts descending', async () => {
    const dir = join(tmpDir, 'sorted');
    await mkdir(dir, { recursive: true });
    const earlier = baseEvent('a', '2025-05-14T12:00:00.000Z');
    const later = baseEvent('b', '2025-05-14T12:00:01.000Z');
    await writeFile(
      join(dir, 's.jsonl'),
      JSON.stringify(earlier) + '\n' + JSON.stringify(later) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('b');
    expect(result[1]?.id).toBe('a');
  });

  it('reads detections across multiple jsonl files', async () => {
    const dir = join(tmpDir, 'multi');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 's1.jsonl'),
      JSON.stringify(baseEvent('a', '2025-05-14T12:00:00.000Z')) + '\n',
    );
    await writeFile(
      join(dir, 's2.jsonl'),
      JSON.stringify(baseEvent('b', '2025-05-14T12:00:00.000Z')) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(2);
  });

  it('ignores blank lines', async () => {
    const dir = join(tmpDir, 'blanks');
    await mkdir(dir, { recursive: true });
    const event = baseEvent('a', '2025-05-14T12:00:00.000Z');
    await writeFile(join(dir, 's.jsonl'), '\n' + JSON.stringify(event) + '\n\n\n');
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
  });

  it('parses a valid enrichment event', async () => {
    const dir = join(tmpDir, 'enrichment-valid');
    await mkdir(dir, { recursive: true });
    const event = baseEnrichmentEvent('e1', '2025-05-14T12:34:56.000Z');
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(event) + '\n');
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('mcp.detection_enrichment');
    expect(result[0]?.detection.category).toBe('pii_detected');
  });

  it('skips enrichment without rpcId', async () => {
    const dir = join(tmpDir, 'enrichment-no-rpcid');
    await mkdir(dir, { recursive: true });
    const event = baseEnrichmentEvent('e2', '2025-05-14T12:34:56.000Z');
    delete event['rpcId'];
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(event) + '\n');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('skips enrichment with invalid rpcId type', async () => {
    const dir = join(tmpDir, 'enrichment-bad-rpcid');
    await mkdir(dir, { recursive: true });
    const event = baseEnrichmentEvent('e3', '2025-05-14T12:34:56.000Z');
    event['rpcId'] = true;
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(event) + '\n');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('skips enrichment with invalid direction', async () => {
    const dir = join(tmpDir, 'enrichment-bad-direction');
    await mkdir(dir, { recursive: true });
    const event = baseEnrichmentEvent('e4', '2025-05-14T12:34:56.000Z');
    event['direction'] = 'bidirectional';
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(event) + '\n');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('reads mixed mcp.request and mcp.detection_enrichment, sorted desc by ts', async () => {
    const dir = join(tmpDir, 'enrichment-mixed');
    await mkdir(dir, { recursive: true });
    const req = baseEvent('a', '2025-05-14T12:00:00.000Z');
    const enr = baseEnrichmentEvent('b', '2025-05-14T12:00:01.000Z');
    // rpcId distinto: terna (session, rpcId, direction) NO correlaciona,
    // asi que NO hay join y ambas variantes aparecen como filas separadas.
    // El caso "misma terna -> join" lo cubre el test de correlacion positiva.
    enr['rpcId'] = 999;
    await writeFile(
      join(dir, 's.jsonl'),
      JSON.stringify(req) + '\n' + JSON.stringify(enr) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('b');
    expect(result[0]?.type).toBe('mcp.detection_enrichment');
    expect(result[1]?.id).toBe('a');
    expect(result[1]?.type).toBe('mcp.request');
  });

  it('joins enrichment onto matching request by (session, rpcId, direction)', async () => {
    const dir = join(tmpDir, 'join-positive');
    await mkdir(dir, { recursive: true });
    const req = baseEvent('a', '2025-05-14T12:00:00.000Z');
    const enr = baseEnrichmentEvent('b', '2025-05-14T12:00:01.000Z');
    // baseEvent y baseEnrichmentEvent emiten la misma terna por defecto
    // (session 'sess', rpcId 1, direction 'client_to_server').
    await writeFile(
      join(dir, 's.jsonl'),
      JSON.stringify(req) + '\n' + JSON.stringify(enr) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('mcp.request');
    expect(result[0]?.id).toBe('a');
    const row = result[0];
    if (row?.type !== 'mcp.request') throw new Error('expected mcp.request');
    // detection original (regex) PRESERVADA, no reemplazada (opcion b).
    expect(row.detection.category).toBe('tool_call_allowed');
    // enrichment NER adjunto.
    expect(row.enrichment?.category).toBe('pii_detected');
  });

  it('keeps an orphan enrichment as its own row when no request matches', async () => {
    const dir = join(tmpDir, 'join-orphan');
    await mkdir(dir, { recursive: true });
    const enr = baseEnrichmentEvent('e1', '2025-05-14T12:00:00.000Z');
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(enr) + '\n');
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('mcp.detection_enrichment');
    expect(result[0]?.id).toBe('e1');
  });

  it('does not join when the triple differs (different rpcId)', async () => {
    const dir = join(tmpDir, 'join-no-match');
    await mkdir(dir, { recursive: true });
    const req = baseEvent('a', '2025-05-14T12:00:00.000Z');
    const enr = baseEnrichmentEvent('b', '2025-05-14T12:00:01.000Z');
    enr['rpcId'] = 2;
    await writeFile(
      join(dir, 's.jsonl'),
      JSON.stringify(req) + '\n' + JSON.stringify(enr) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(2);
    const reqRow = result.find((r) => r.id === 'a');
    if (reqRow?.type !== 'mcp.request') throw new Error('expected mcp.request');
    expect(reqRow.enrichment).toBeUndefined();
  });

  it('dedupes a repeated line by envelope id', async () => {
    const dir = join(tmpDir, 'join-dedupe');
    await mkdir(dir, { recursive: true });
    const req = baseEvent('a', '2025-05-14T12:00:00.000Z');
    const line = JSON.stringify(req) + '\n';
    await writeFile(join(dir, 's.jsonl'), line + line);
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('a');
  });

  it('excludes self-test synthetic events (mcp === SELFTEST_WRAPPER_NAME)', async () => {
    const dir = join(tmpDir, 'selftest-excluded');
    await mkdir(dir, { recursive: true });
    const selftest = baseEvent('st1', '2025-05-14T12:00:00.000Z');
    selftest['mcp'] = SELFTEST_WRAPPER_NAME;
    await writeFile(join(dir, 's.jsonl'), JSON.stringify(selftest) + '\n');
    const result = await readDetections(dir);
    expect(result).toEqual([]);
  });

  it('excludes only self-test events, keeping real traffic in the same file', async () => {
    const dir = join(tmpDir, 'selftest-mixed');
    await mkdir(dir, { recursive: true });
    const real = baseEvent('real1', '2025-05-14T12:00:00.000Z');
    const selftest = baseEvent('st1', '2025-05-14T12:00:01.000Z');
    selftest['mcp'] = SELFTEST_WRAPPER_NAME;
    await writeFile(
      join(dir, 's.jsonl'),
      JSON.stringify(real) + '\n' + JSON.stringify(selftest) + '\n',
    );
    const result = await readDetections(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('real1');
  });
});

function toolsResponse(mcp: string, ts: string, names: string[]): Record<string, unknown> {
  return {
    v: 1, id: ts, ts, session: 'sess', mcp,
    type: 'mcp.response', direction: 'server_to_client', rpcId: 1, bytes: 100,
    result: { tools: names.map((name) => ({ name })) },
  };
}

describe('readLatestToolCount', () => {
  it('returns count + ts of the latest tools/list response for the mcp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xcg-tc-'));
    // ULID-ish names: lexicographic order == chronological.
    await writeFile(join(dir, '01A.jsonl'),
      JSON.stringify(toolsResponse('notion', '2026-06-01T00:00:00Z', ['a', 'b'])) + '\n');
    await writeFile(join(dir, '01B.jsonl'),
      JSON.stringify(toolsResponse('notion', '2026-06-02T00:00:00Z', ['a', 'b', 'c'])) + '\n');
    const tc = await readLatestToolCount('notion', dir);
    expect(tc).toEqual({ count: 3, ts: '2026-06-02T00:00:00Z' });
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when there is no tools/list response for the mcp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xcg-tc-'));
    // a tools/list for a DIFFERENT mcp must not match.
    await writeFile(join(dir, '01A.jsonl'),
      JSON.stringify(toolsResponse('linear', '2026-06-01T00:00:00Z', ['x'])) + '\n');
    expect(await readLatestToolCount('notion', dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores responses without a tools array; null on missing dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xcg-tc-'));
    await writeFile(join(dir, '01A.jsonl'),
      JSON.stringify({ v: 1, id: 'x', ts: 't', session: 's', mcp: 'notion',
        type: 'mcp.response', direction: 'server_to_client', rpcId: 0,
        result: { protocolVersion: '1' } }) + '\n'); // initialize, no tools[]
    expect(await readLatestToolCount('notion', dir)).toBeNull();
    expect(await readLatestToolCount('notion', join(dir, 'nope'))).toBeNull(); // ENOENT → null
    await rm(dir, { recursive: true, force: true });
  });
});

describe('readAudit — authAlerts', () => {
  const NOW = Date.parse('2026-06-16T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

  function oauthFail(id: string, mcp: string, ts: string, message = 'reauth required'): Record<string, unknown> {
    return { v: 1, id, ts, session: 's', mcp, type: 'proxy.error', kind: 'oauth_failed', message };
  }
  function liveReq(id: string, mcp: string, ts: string): Record<string, unknown> {
    return {
      v: 1, id, ts, session: 's', mcp, type: 'mcp.request', direction: 'client_to_server',
      rpcId: 1, method: 'tools/call', params: {}, bytes: 10, overheadUs: 5,
      detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
    };
  }
  function recovered(id: string, mcp: string, ts: string): Record<string, unknown> {
    return { v: 1, id, ts, session: 'desktop', mcp, type: CONNECTOR_RECOVERED_TYPE };
  }
  async function write(name: string, ...events: Record<string, unknown>[]): Promise<string> {
    const dir = join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return dir;
  }

  it('a) recent oauth_failed with no later traffic → alert', async () => {
    const dir = await write('auth-a', oauthFail('f1', 'notion', iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([
      { mcp: 'notion', lastFailureTs: iso(-HOUR), message: 'reauth required' },
    ]);
  });

  it('b) oauth_failed followed by a later mcp.request (same mcp) → no alert', async () => {
    const dir = await write('auth-b', oauthFail('f1', 'notion', iso(-2 * HOUR)), liveReq('r1', 'notion', iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([]);
  });

  it('c) oauth_failed older than 24h → no alert', async () => {
    const dir = await write('auth-c', oauthFail('f1', 'notion', iso(-25 * HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([]);
  });

  it('d) two connectors, one down one healthy → only the down one', async () => {
    const dir = await write('auth-d', oauthFail('f1', 'notion', iso(-HOUR)), liveReq('r1', 'linear', iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts.map((a) => a.mcp)).toEqual(['notion']);
  });

  it('e) self-test wrapper never generates an alert', async () => {
    const dir = await write('auth-e', oauthFail('f1', SELFTEST_WRAPPER_NAME, iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([]);
  });

  it('f) oauth_failed followed by a later recovery marker → no alert', async () => {
    const dir = await write('auth-f', oauthFail('f1', 'stripe', iso(-2 * HOUR)), recovered('rec1', 'stripe', iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([]);
  });

  it('g) recovery marker OLDER than the failure → alert persists', async () => {
    const dir = await write('auth-g', recovered('rec1', 'stripe', iso(-2 * HOUR)), oauthFail('f1', 'stripe', iso(-HOUR)));
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts.map((a) => a.mcp)).toEqual(['stripe']);
  });

  it('h) fail → recovery → later re-failure → alert reappears', async () => {
    const dir = await write(
      'auth-h',
      oauthFail('f1', 'stripe', iso(-3 * HOUR)),
      recovered('rec1', 'stripe', iso(-2 * HOUR)),
      oauthFail('f2', 'stripe', iso(-HOUR)),
    );
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([
      { mcp: 'stripe', lastFailureTs: iso(-HOUR), message: 'reauth required' },
    ]);
  });

  it('i) both live traffic and recovery after failure → no alert (later signal wins)', async () => {
    const dir = await write(
      'auth-i',
      oauthFail('f1', 'stripe', iso(-3 * HOUR)),
      recovered('rec1', 'stripe', iso(-2 * HOUR)),
      liveReq('r1', 'stripe', iso(-HOUR)),
    );
    const { authAlerts } = await readAudit(dir, NOW);
    expect(authAlerts).toEqual([]);
  });
});
