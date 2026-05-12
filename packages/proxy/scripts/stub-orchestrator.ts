// Stub del orquestador: bind del socket compartido, accept conexiones de los
// wrappers, imprime cada línea ndjson recibida a stdout con prefijo
// [mcp:session]. Single-instance via probe activo (ECONNREFUSED == stale).
// No persiste nada, no toma decisiones — solo observa. Sustituido por el
// orquestador real (Desktop main process) en hitos posteriores.

import { mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { resolveSocketPath } from '../src/socket-path.js';
import { LineSplitter } from '../src/splitter.js';

type StaleCheck = 'alive' | 'stale' | 'missing';
const PROBE_TIMEOUT_MS = 200;

function probeExisting(path: string): Promise<StaleCheck> {
  return new Promise((resolve) => {
    const client = createConnection(path);
    let settled = false;
    const settle = (r: StaleCheck): void => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      client.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => settle('alive'), PROBE_TIMEOUT_MS);
    client.once('connect', () => {
      clearTimeout(timer);
      settle('alive');
    });
    client.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ECONNREFUSED') settle('stale');
      else if (err.code === 'ENOENT') settle('missing');
      // Cualquier otra cosa (EACCES, EPERM...) → conservador: tratar como vivo
      // para no borrar un socket cuya naturaleza no conocemos.
      else settle('alive');
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function handleConnection(conn: Socket): void {
  const splitter = new LineSplitter();
  conn.on('data', (chunk: Buffer) => {
    for (const line of splitter.feed(chunk)) {
      let mcp = '?';
      let session = '?';
      try {
        const parsed = JSON.parse(line) as { mcp?: unknown; session?: unknown };
        if (typeof parsed.mcp === 'string') mcp = parsed.mcp;
        if (typeof parsed.session === 'string') session = parsed.session;
      } catch {
        // línea no-JSON: mantener prefix [?:?]
      }
      process.stdout.write(`[${mcp}:${session}] ${line}\n`);
    }
  });
  // Silencio en error/close del cliente: el wrapper se ocupa de su lado.
  conn.on('error', () => {});
}

async function main(): Promise<void> {
  const path = resolveSocketPath();

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const existing = await probeExisting(path);
  if (existing === 'alive') {
    process.stderr.write(
      `xcg-stub: another instance is already listening on ${path}\n`,
    );
    process.exit(1);
  }
  if (existing === 'stale') {
    try {
      unlinkSync(path);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        process.stderr.write(`xcg-stub: cannot unlink stale socket: ${e.message}\n`);
        process.exit(1);
      }
    }
  }

  const server = createServer(handleConnection);

  try {
    await listen(server, path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`xcg-stub: listen failed (${e.code ?? 'unknown'}): ${e.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`xcg-stub: listening on ${path}\n`);

  const shutdown = (): void => {
    server.close(() => {
      try {
        unlinkSync(path);
      } catch {
        /* ya no está, ignorar */
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`xcg-stub: fatal: ${msg}\n`);
  process.exit(1);
});
