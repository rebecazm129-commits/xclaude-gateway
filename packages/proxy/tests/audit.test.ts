import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlWriter } from '../src/audit.js';

const sampleEnvelope = {
  v: 1,
  id: '01HZQTEST00000000000000000',
  ts: '2026-05-12T00:00:00.000Z',
  session: '01HZQSESSION0000000000000A',
  mcp: 'test',
  type: 'proxy.started',
} as const;

describe('JsonlWriter', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-audit-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates parent dir with mode 0700 and file with mode 0600', () => {
    const filePath = join(tmp, 'wrappers', 'session.jsonl');
    const writer = new JsonlWriter(filePath);
    writer.close();

    const dirMode = statSync(join(tmp, 'wrappers')).mode & 0o777;
    const fileMode = statSync(filePath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('appends each envelope as one ndjson line', () => {
    const filePath = join(tmp, 'session.jsonl');
    const writer = new JsonlWriter(filePath);
    writer.write({ ...sampleEnvelope, type: 'a' });
    writer.write({ ...sampleEnvelope, type: 'b' });
    writer.write({ ...sampleEnvelope, type: 'c' });
    writer.close();

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).type).toBe('a');
    expect(JSON.parse(lines[1]!).type).toBe('b');
    expect(JSON.parse(lines[2]!).type).toBe('c');
  });

  it('mkdir is idempotent (second constructor over existing dir does not throw)', () => {
    new JsonlWriter(join(tmp, 'wrappers', 'session-A.jsonl')).close();
    expect(() =>
      new JsonlWriter(join(tmp, 'wrappers', 'session-B.jsonl')).close(),
    ).not.toThrow();
  });

  it('close() is idempotent (second call is a no-op, not EBADF)', () => {
    const writer = new JsonlWriter(join(tmp, 's.jsonl'));
    writer.close();
    expect(() => writer.close()).not.toThrow();
  });

  it('write() after close() throws', () => {
    const writer = new JsonlWriter(join(tmp, 's.jsonl'));
    writer.close();
    expect(() => writer.write(sampleEnvelope)).toThrow(/after close/);
  });

  it('append mode preserves prior content across separate JsonlWriter instances on same path', () => {
    const filePath = join(tmp, 'session.jsonl');

    const w1 = new JsonlWriter(filePath);
    w1.write({ ...sampleEnvelope, type: 'first' });
    w1.close();

    const w2 = new JsonlWriter(filePath);
    w2.write({ ...sampleEnvelope, type: 'second' });
    w2.close();

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe('first');
    expect(JSON.parse(lines[1]!).type).toBe('second');
  });
});
