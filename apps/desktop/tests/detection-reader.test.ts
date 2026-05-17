import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDetections } from '../src/main/detection-reader.js';

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
});
