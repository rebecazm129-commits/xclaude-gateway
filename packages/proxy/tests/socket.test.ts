import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Envelope } from '../src/audit.js';
import { SocketWriter, type SocketDropReason } from '../src/socket.js';

const sampleEnvelope: Envelope = {
  v: 1,
  id: '01HZQTEST00000000000000000',
  ts: '2026-05-12T00:00:00.000Z',
  session: '01HZQSESSION0000000000000A',
  mcp: 'test',
  type: 'proxy.started',
};

function envelopeWith(overrides: Partial<Envelope>): Envelope {
  return { ...sampleEnvelope, ...overrides };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
  pollMs = 5,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

interface MockServer {
  server: Server;
  path: string;
  received: string[];
  conns: Socket[];
  /** Resolves with the first accepted client socket. */
  firstConn: Promise<Socket>;
}

async function startMockServer(tmp: string): Promise<MockServer> {
  const path = join(tmp, 'mock.sock');
  const received: string[] = [];
  const conns: Socket[] = [];
  let resolveFirst!: (s: Socket) => void;
  const firstConn = new Promise<Socket>((r) => {
    resolveFirst = r;
  });

  const server = createServer((conn) => {
    conns.push(conn);
    resolveFirst(conn);
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        received.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return { server, path, received, conns, firstConn };
}

async function closeMockServer(mock: MockServer): Promise<void> {
  for (const c of mock.conns) c.destroy();
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
}

describe('SocketWriter', () => {
  let tmp: string;
  let mock: MockServer | null;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-sock-test-'));
    mock = null;
  });

  afterEach(async () => {
    if (mock) await closeMockServer(mock);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('connect → write → ndjson line received', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    await mock.firstConn;
    // Server-side 'connection' fires before client-side 'connect'; wait a tick
    // so the client state machine flips to 'connected'.
    await sleep(20);

    writer.write(envelopeWith({ type: 'a' }));
    writer.write(envelopeWith({ type: 'b' }));

    await waitFor(() => mock!.received.length >= 2);
    expect(mock.received).toHaveLength(2);
    expect(JSON.parse(mock.received[0]!).type).toBe('a');
    expect(JSON.parse(mock.received[1]!).type).toBe('b');
    expect(drops).toHaveLength(0);

    writer.close();
  });

  it('write during connecting is a silent no-op', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    // Síncrono justo tras construir: el connect aún no ha resuelto.
    writer.write(envelopeWith({ type: 'too_early' }));

    await mock.firstConn;
    await sleep(20);

    writer.write(envelopeWith({ type: 'after_connect' }));

    await waitFor(() => mock!.received.length >= 1);
    // Damos margen por si el "too_early" se colara — no debería.
    await new Promise((r) => setTimeout(r, 20));

    expect(mock.received).toHaveLength(1);
    expect(JSON.parse(mock.received[0]!).type).toBe('after_connect');
    expect(drops).toHaveLength(0);

    writer.close();
  });

  it('preserves order and framing across multiple writes', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    await mock.firstConn;
    await sleep(20);

    writer.write(envelopeWith({ type: 'one' }));
    writer.write(envelopeWith({ type: 'two' }));
    writer.write(envelopeWith({ type: 'three' }));

    await waitFor(() => mock!.received.length >= 3);
    expect(mock.received.map((l) => JSON.parse(l).type)).toEqual(['one', 'two', 'three']);
    expect(drops).toHaveLength(0);

    writer.close();
  });

  it('connect_failed: nonexistent path drops once', async () => {
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(join(tmp, 'does-not-exist.sock'), (r, m) =>
      drops.push([r, m]),
    );

    await waitFor(() => drops.length > 0);
    expect(drops).toHaveLength(1);
    expect(drops[0]![0]).toBe('connect_failed');
    expect(drops[0]![1]).toMatch(/.+/);

    // Esperar un poco más para asegurar que no llega un segundo drop.
    await new Promise((r) => setTimeout(r, 30));
    expect(drops).toHaveLength(1);

    writer.close();
  });

  it('server_disconnected: peer close drops once', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    const conn = await mock.firstConn;
    await sleep(20);

    conn.destroy();

    await waitFor(() => drops.length > 0);
    expect(drops).toHaveLength(1);
    expect(drops[0]![0]).toBe('server_disconnected');

    writer.close();
  });

  it('write after drop is a silent no-op', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    const conn = await mock.firstConn;
    await sleep(20);
    conn.destroy();
    await waitFor(() => drops.length > 0);

    expect(() => {
      writer.write(envelopeWith({ type: 'x' }));
      writer.write(envelopeWith({ type: 'y' }));
      writer.write(envelopeWith({ type: 'z' }));
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    expect(drops).toHaveLength(1);

    writer.close();
  });

  it('close() is idempotent and never emits onDrop', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    await mock.firstConn;
    await sleep(20);

    writer.close();
    expect(() => writer.close()).not.toThrow();

    await new Promise((r) => setTimeout(r, 30));
    expect(drops).toHaveLength(0);
  });

  it('close() during connecting aborts without onDrop', async () => {
    mock = await startMockServer(tmp);
    const drops: Array<[SocketDropReason, string]> = [];
    const writer = new SocketWriter(mock.path, (r, m) => drops.push([r, m]));

    // Cierre síncrono antes de que connect resuelva.
    writer.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(drops).toHaveLength(0);
  });
});
