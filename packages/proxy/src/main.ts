// Invariante MCP: el wrapper nunca escribe a stdout (reservado a frames JSON-RPC del MCP envuelto).
// La única salida del wrapper a stderr es: la bootstrap line al arrancar y errores fatales pre-sink.
// Los eventos canónicos del wrapper van al JSONL per-sesión vía EventSink.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ulid } from 'ulid';

import { runLogin } from './login.js';
import { KeychainOAuthProvider, ReauthRequiredError } from './oauth-provider.js';

import { JsonlWriter } from './audit.js';
import { DetectionEngine } from './detection/engine.js';
import { ACTIVE_DETECTORS } from './detection/detectors/index.js';
import { AsyncDetectorNer } from './detection/ner/async-detector.js';
import { EventSink, createEnrichmentSink, type Direction } from './events.js';
import { createFrameProcessor, type FrameProcessor } from './frame-processor.js';
import { InflightTracker } from './latency.js';
import { classify, classifyFromMessage, type ClassifiedFrame } from './parser.js';
import {
  createGracefulShutdown,
  computeExitCode,
  FSYNC_TIMEOUT_MS,
  SIGTERM_GRACE_MS,
  SOCKET_END_TIMEOUT_MS,
  type ChildExitInfo,
  type ShutdownReason,
} from './shutdown.js';
import { SocketWriter } from './socket.js';
import { resolveSocketPath } from './socket-path.js';
import { LineSplitter } from './splitter.js';
import { elapsedUs } from './timing.js';

// --- Exit codes (alineados con xcg-config) ---
const EXIT_OK = 0;
const EXIT_GENERIC_ERROR = 1;
const EXIT_USAGE_OR_CORRUPT = 2;

const USAGE =
  'usage: xcg-proxy <stdio|http|login> [options]\n' +
  '  stdio --wrap <command> --name <id> -- [args...]\n' +
  '  http  --url <url> --name <id>\n' +
  '  login --url <url> --name <id> [--scope "<scopes separados por espacio>"]\n';

export interface ParsedArgs {
  wrap: string;
  name: string;
  childArgs: readonly string[];
}

export interface HttpArgs {
  url: string;
  name: string;
}

// --- Cola compartida de observación (Hito 6 Fase 3 sub-paso 3.a) -------------
// Extraída del cuerpo de runStdio para que el path HTTP (Fase 3) la reutilice
// con classifyFromMessage. emitFrame es el sumidero único que aplica
// processFrame → sink.emit por evento emitido. processStdioChunk es la
// variante stdio: splitter + classify(line) por cada línea del chunk.

function emitFrame(
  sink: EventSink,
  processFrame: FrameProcessor,
  frame: ClassifiedFrame,
  direction: Direction,
  bytes: number,
  line: string,
  tsObservedNs: bigint,
  tsWallMs: number,
): void {
  for (const ev of processFrame(frame, direction, bytes, line, tsObservedNs, tsWallMs)) {
    sink.emit(ev);
  }
}

function processStdioChunk(
  chunk: Buffer,
  direction: Direction,
  splitter: LineSplitter,
  sink: EventSink,
  processFrame: FrameProcessor,
): number {
  const tsObservedNs = process.hrtime.bigint();
  const tsWallMs = Date.now();
  const lines = splitter.feed(chunk);
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1; // +1 por el \n consumido por el splitter
    emitFrame(sink, processFrame, classify(line), direction, bytes, line, tsObservedNs, tsWallMs);
  }
  return lines.length;
}

export function runStdio(opts: ParsedArgs): void {
  const { wrap, name, childArgs } = opts;

  const session = ulid();
  const baseDir = join(homedir(), 'Library', 'Application Support', 'xCLAUDE Gateway');
  const auditFile = join(baseDir, 'wrappers', `${session}.jsonl`);

  let writer: JsonlWriter;
  try {
    writer = new JsonlWriter(auditFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`xcg-proxy: cannot open audit file ${auditFile}: ${msg}\n`);
    process.exit(1);
  }

  process.stderr.write(`xcg-proxy: session ${session} auditing to ${auditFile}\n`);

  // Closure tardío: el callback se invoca solo desde listeners async del socket
  // ('error', 'close'), nunca síncrono desde el constructor de SocketWriter, así
  // que `sink` está siempre asignado cuando se ejecuta.
  let sink!: EventSink;
  const socketPath = resolveSocketPath();
  const socketWriter = new SocketWriter(socketPath, (reason, message) => {
    sink.emit({ type: 'proxy.socket_dropped', reason, message });
  });
  sink = new EventSink(name, [writer, socketWriter], session);

  process.stderr.write(`xcg-proxy: socket mirror at ${socketPath}\n`);

  const startMs = Date.now();

  sink.emit({
    type: 'proxy.started',
    pid: process.pid,
    wrap,
    wrappedArgs: childArgs,
  });

  const child = spawn(wrap, childArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  child.on('error', (err) => {
    sink.emit({ type: 'proxy.error', kind: 'spawn_failed', message: err.message });
    sink.close();
    process.exit(127);
  });

  child.on('spawn', () => {
    const childPid = child.pid ?? 0;
    sink.emit({ type: 'proxy.child_spawned', childPid });
  });

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    sink.emit({
      type: 'proxy.error',
      kind: 'unexpected',
      message: 'child pipes unavailable',
    });
    sink.close();
    process.exit(1);
  }

  // Forwarding PRIMERO. Observación + clasificación DESPUÉS.
  // stderr del child se CAPTURA (no se forwardea): una sola fuente de verdad
  // para los logs del MCP es el JSONL + mirror del stub.
  process.stdin.pipe(childStdin);
  childStdout.pipe(process.stdout, { end: false });

  const stdinSplitter = new LineSplitter();
  const stdoutSplitter = new LineSplitter();
  const stderrSplitter = new LineSplitter();
  const tracker = new InflightTracker();
  const engine = new DetectionEngine(ACTIVE_DETECTORS);
  const asyncDetector = new AsyncDetectorNer({
    workerScript: join(__dirname, 'xcg-ner-worker.cjs'),
    enrichmentSink: createEnrichmentSink(sink),
    onDrop: (reason, jobId, rpcId) => {
      sink.emit({ type: 'proxy.ner_dropped', reason, jobId, rpcId });
    },
    onWorkerDied: (cause, pendingDropped) => {
      sink.emit({ type: 'proxy.ner_worker_died', cause, pendingDropped });
    },
  });
  const processFrame = createFrameProcessor({ tracker, engine, asyncDetector, mcp: name, session });
  let framesIn = 0;
  let framesOut = 0;
  let framesStderr = 0;

  process.stdin.on('data', (chunk: Buffer) => {
    framesIn += processStdioChunk(chunk, 'client_to_server', stdinSplitter, sink, processFrame);
  });

  childStdout.on('data', (chunk: Buffer) => {
    framesOut += processStdioChunk(chunk, 'server_to_client', stdoutSplitter, sink, processFrame);
  });

  childStderr.on('data', (chunk: Buffer) => {
    const tsObservedNs = process.hrtime.bigint();
    const lines = stderrSplitter.feed(chunk);
    framesStderr += lines.length;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      sink.emit({
        type: 'mcp.stderr',
        text: line,
        bytes,
        overheadUs: elapsedUs(tsObservedNs),
      });
    }
  });

  // Estado del child consumido por el adapter de ShutdownDeps. childExitInfo
  // se actualiza una sola vez desde el listener child.on('exit'); childAlive
  // pasa a false en ese mismo punto. childExitPromise se resuelve cuando el
  // child muere y es la misma Promise que se devuelve en cada waitForExit().
  let childAlive = true;
  let childExitInfo: ChildExitInfo = { code: null, signal: null };
  let resolveChildExit!: () => void;
  const childExitPromise = new Promise<void>((resolve) => {
    resolveChildExit = resolve;
  });

  const gracefulShutdown = createGracefulShutdown({
    child: {
      stdinEnd: () => {
        childStdin.end();
      },
      kill: (signal) => {
        child.kill(signal);
      },
      isAlive: () => childAlive,
      waitForExit: () => childExitPromise,
      exitInfo: () => childExitInfo,
    },
    socket: {
      isAlive: () => socketWriter.isAlive(),
      end: () => socketWriter.end(),
      destroy: () => socketWriter.destroy(),
    },
    jsonl: {
      fsync: () => writer.fsync(),
      close: () => writer.close(),
    },
    worker: {
      terminate: (timeoutMs) => asyncDetector.terminate(timeoutMs),
    },
    emitShutdown: (reason, exitCode) => {
      sink.emit({ type: 'proxy.shutdown', reason, exitCode });
    },
    exit: (code) => process.exit(code),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    stderr: (msg) => {
      process.stderr.write(msg);
    },
  });

  child.on('exit', (code, signal) => {
    childAlive = false;
    childExitInfo = { code, signal };
    resolveChildExit();
    sink.emit({
      type: 'proxy.child_exited',
      code,
      signal,
      runtimeMs: Date.now() - startMs,
      framesIn,
      framesOut,
      framesStderr,
      framesInIncomplete: stdinSplitter.incompleteBytes(),
      framesOutIncomplete: stdoutSplitter.incompleteBytes(),
    });
    void gracefulShutdown('child_exited');
  });

  process.stdin.on('end', () => {
    void gracefulShutdown('parent_closed_stdin');
  });

  process.on('SIGINT', () => {
    void gracefulShutdown('signal_received');
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('signal_received');
  });
}

// --- HTTP transport (Hito 6 Fase 3 sub-paso 3.b) ----------------------------
// Bridge stdio ↔ HTTP: el lado Claude habla con un StdioServerTransport del
// SDK; el lado remoto se conecta con StreamableHTTPClientTransport. Las dos
// observaciones se inyectan en el mismo emitFrame compartido vía
// classifyFromMessage. NO hay splitter — el SDK entrega JSONRPCMessage ya
// parseado por ambos lados. Sin graceful shutdown todavía (3.c lo cablea).

// El SDK lanza StreamableHTTPError con `code` numérico (status HTTP) en fallos de
// status; un fallo de conexión (fetch rechazado, ECONNREFUSED, DNS) no trae code
// numérico. oauth_failed lo emitirá Fase 4 (UnauthorizedError del authProvider).
function classifyHttpClientError(err: Error): 'http_connect_failed' | 'http_status_error' {
  return typeof (err as { code?: unknown }).code === 'number' ? 'http_status_error' : 'http_connect_failed';
}

async function runHttp(opts: HttpArgs): Promise<void> {
  const { url, name } = opts;

  const session = ulid();
  const baseDir = join(homedir(), 'Library', 'Application Support', 'xCLAUDE Gateway');
  const auditFile = join(baseDir, 'wrappers', `${session}.jsonl`);

  let writer: JsonlWriter;
  try {
    writer = new JsonlWriter(auditFile);
  } catch (err) {
    process.stderr.write(`xcg-proxy: cannot open audit file ${auditFile}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.stderr.write(`xcg-proxy: session ${session} auditing to ${auditFile}\n`);

  let sink!: EventSink;
  const socketPath = resolveSocketPath();
  const socketWriter = new SocketWriter(socketPath, (reason, message) => {
    sink.emit({ type: 'proxy.socket_dropped', reason, message });
  });
  sink = new EventSink(name, [writer, socketWriter], session);
  process.stderr.write(`xcg-proxy: socket mirror at ${socketPath}\n`);

  const startMs = Date.now();

  const tracker = new InflightTracker();
  const engine = new DetectionEngine(ACTIVE_DETECTORS);
  const asyncDetector = new AsyncDetectorNer({
    workerScript: join(__dirname, 'xcg-ner-worker.cjs'),
    enrichmentSink: createEnrichmentSink(sink),
    onDrop: (reason, jobId, rpcId) => { sink.emit({ type: 'proxy.ner_dropped', reason, jobId, rpcId }); },
    onWorkerDied: (cause, pendingDropped) => { sink.emit({ type: 'proxy.ner_worker_died', cause, pendingDropped }); },
  });
  const processFrame = createFrameProcessor({ tracker, engine, asyncDetector, mcp: name, session });

  // Auth provider always attached (probe 4.b.2 confirma: si el remoto no pide
  // auth, el SDK no invoca auth() → tokens() devuelve undefined cacheado y
  // ningún Authorization header se envía; comportamiento token-less limpio).
  const authProvider = new KeychainOAuthProvider(name, (e) => {
    sink.emit({ type: 'proxy.token', ...e });
  });
  const isAuthError = (e: unknown): boolean =>
    e instanceof ReauthRequiredError || e instanceof UnauthorizedError;

  const httpClient = new StreamableHTTPClientTransport(new URL(url), { authProvider });
  const stdioServer = new StdioServerTransport();

  let framesIn = 0;
  let framesOut = 0;

  const observe = (msg: JSONRPCMessage, direction: Direction): void => {
    const tsObservedNs = process.hrtime.bigint();
    const tsWallMs = Date.now();
    const line = JSON.stringify(msg);
    const bytes = Buffer.byteLength(line, 'utf8'); // sin +1: el SDK entrega el objeto, no la línea con \n
    emitFrame(sink, processFrame, classifyFromMessage(msg), direction, bytes, line, tsObservedNs, tsWallMs);
    if (direction === 'client_to_server') framesIn++;
    else framesOut++;
  };

  stdioServer.onmessage = (msg) => {
    observe(msg, 'client_to_server');
    void httpClient.send(msg).catch((err: unknown) => {
      if (isAuthError(err)) {
        sink.emit({
          type: 'proxy.error',
          kind: 'oauth_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        // fail-fast: error de auth en runtime = re-login necesario (runtime no
        // puede hacerlo). Cerrar la sesión (proxy.shutdown reason=auth_failed)
        // para que el cliente no espere 60s.
        void runHttpShutdown('auth_failed');
      } else {
        process.stderr.write(`xcg-proxy: forward to remote failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
  };
  httpClient.onmessage = (msg) => {
    observe(msg, 'server_to_client');
    void stdioServer.send(msg).catch((err: unknown) => {
      process.stderr.write(`xcg-proxy: forward to client failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  };

  httpClient.onerror = (err) => {
    sink.emit({ type: 'proxy.error', kind: classifyHttpClientError(err), message: err.message });
  };
  stdioServer.onerror = (err) => {
    sink.emit({ type: 'proxy.error', kind: 'unexpected', message: err.message });
  };

  // --- Lifecycle: shutdown HTTP-shaped (espejo de createGracefulShutdown
  // pasos 6-10; reimplementación ligera porque deps.child es REQUIRED en el
  // orquestador child-shaped y HTTP no tiene equivalente).
  let shuttingDown: Promise<void> | null = null;

  const tearDownTail = async (exitCode: number): Promise<void> => {
    // Paso 6b: worker.terminate → drena onDrop pendientes vía sink antes
    // del socket.end.
    await asyncDetector.terminate(SIGTERM_GRACE_MS);
    // Paso 7: socket end/timeout/destroy.
    if (socketWriter.isAlive()) {
      await Promise.race([
        socketWriter.end(),
        new Promise<void>((resolve) => setTimeout(() => { socketWriter.destroy(); resolve(); }, SOCKET_END_TIMEOUT_MS)),
      ]);
    }
    // Paso 8: jsonl.fsync con timeout.
    await Promise.race([
      writer.fsync(),
      new Promise<void>((resolve) => setTimeout(() => {
        process.stderr.write('[xcg] fsync timeout, exiting anyway\n');
        resolve();
      }, FSYNC_TIMEOUT_MS)),
    ]);
    // Paso 9
    writer.close();
    // Paso 10
    process.exit(exitCode);
  };

  const runHttpShutdown = (reason: ShutdownReason): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async (): Promise<void> => {
      const exitCode = computeExitCode(reason, false, { code: null, signal: null });
      sink.emit({ type: 'proxy.shutdown', reason, exitCode });
      await tearDownTail(exitCode);
    })();
    return shuttingDown;
  };

  // Triggers: TODOS instalados antes de await httpClient.start() — el SDK
  // exige que onmessage/onerror/onclose estén seteados antes del start.
  // Guard "primer-cierre-gana" en stdin.end y httpClient.onclose: si la
  // sesión ya está cerrando, no se emite un segundo proxy.http_closed
  // (runHttpShutdown ya es idempotente, pero queremos un único registro
  // del peer que disparó el cierre).
  process.stdin.on('end', () => {
    if (shuttingDown !== null) return;
    sink.emit({
      type: 'proxy.http_closed',
      runtimeMs: Date.now() - startMs,
      side: 'client',
      framesIn,
      framesOut,
    });
    void runHttpShutdown('parent_closed_stdin');
  });

  // El SDK NO invoca onclose al CAER el remoto (solo en un close() explícito; las
  // caídas las gestiona su reconexión interna y/o emergen como onerror). Este hook
  // cubre el cierre de transporte genuino; la caída remota queda auditada vía
  // proxy.error (onerror) y la sesión la cierra el lado cliente (stdin EOF). Verificado
  // empíricamente en el smoke de 3.c.2.
  httpClient.onclose = () => {
    if (shuttingDown !== null) return;
    sink.emit({
      type: 'proxy.http_closed',
      runtimeMs: Date.now() - startMs,
      side: 'remote',
      framesIn,
      framesOut,
    });
    void runHttpShutdown('remote_closed');
  };

  process.on('SIGINT', () => { void runHttpShutdown('signal_received'); });
  process.on('SIGTERM', () => { void runHttpShutdown('signal_received'); });

  // Start failure: la sesión NO abrió. Emitimos proxy.error y hacemos
  // teardown directo sin proxy.shutdown ni proxy.http_closed (espejo del
  // comportamiento de runStdio en spawn_failed, que tampoco emite shutdown).
  try {
    await httpClient.start();
  } catch (err) {
    const e = err as Error;
    const kind = isAuthError(e) ? 'oauth_failed' : classifyHttpClientError(e);
    sink.emit({ type: 'proxy.error', kind, message: e.message });
    if (shuttingDown === null) shuttingDown = tearDownTail(EXIT_GENERIC_ERROR);
    await shuttingDown;
    return;
  }
  try {
    await stdioServer.start();
  } catch (err) {
    const e = err as Error;
    sink.emit({ type: 'proxy.error', kind: 'unexpected', message: e.message });
    if (shuttingDown === null) shuttingDown = tearDownTail(EXIT_GENERIC_ERROR);
    await shuttingDown;
    return;
  }
}

function runStdioMain(rest: string[]): number | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        wrap: { type: 'string' },
        name: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`xcg-proxy: ${(err as Error).message}\n`);
    process.stderr.write(USAGE);
    return EXIT_USAGE_OR_CORRUPT;
  }

  const wrap = parsed.values.wrap;
  const name = parsed.values.name;
  if (typeof wrap !== 'string') {
    process.stderr.write('xcg-proxy: --wrap is required\n');
    process.stderr.write(USAGE);
    return EXIT_USAGE_OR_CORRUPT;
  }
  if (typeof name !== 'string') {
    process.stderr.write('xcg-proxy: --name is required\n');
    process.stderr.write(USAGE);
    return EXIT_USAGE_OR_CORRUPT;
  }

  runStdio({ wrap, name, childArgs: parsed.positionals });
  // Happy path: runStdio established its event listeners. The process
  // stays alive in the event loop until child exit / SIGINT / SIGTERM
  // triggers gracefulShutdown internally. Return null tells cli-entry
  // to NOT call process.exit (which would kill the wrapper prematurely).
  return null;
}

function runHttpMain(rest: string[]): number | null {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { url: { type: 'string' }, name: { type: 'string' } }, strict: true, allowPositionals: false });
  } catch (err) {
    process.stderr.write(`xcg-proxy: ${(err as Error).message}\n`);
    process.stderr.write(USAGE);
    return EXIT_USAGE_OR_CORRUPT;
  }
  const url = parsed.values.url;
  const name = parsed.values.name;
  if (typeof url !== 'string') { process.stderr.write('xcg-proxy: --url is required\n'); process.stderr.write(USAGE); return EXIT_USAGE_OR_CORRUPT; }
  if (typeof name !== 'string') { process.stderr.write('xcg-proxy: --name is required\n'); process.stderr.write(USAGE); return EXIT_USAGE_OR_CORRUPT; }
  try { new URL(url); } catch { process.stderr.write(`xcg-proxy: invalid --url: ${url}\n`); return EXIT_USAGE_OR_CORRUPT; }

  void runHttp({ url, name }).catch((err: unknown) => {
    process.stderr.write(`xcg-proxy: http transport failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_GENERIC_ERROR);
  });
  return null;
}

function runLoginMain(rest: string[]): number | null {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { url: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' } }, strict: true, allowPositionals: false });
  } catch (err) {
    process.stderr.write(`xcg-proxy: ${(err as Error).message}\n`);
    process.stderr.write(USAGE);
    return EXIT_USAGE_OR_CORRUPT;
  }
  const url = parsed.values.url;
  const name = parsed.values.name;
  const scope = parsed.values.scope; // optional, no required-check
  if (typeof url !== 'string') { process.stderr.write('xcg-proxy: --url is required\n'); process.stderr.write(USAGE); return EXIT_USAGE_OR_CORRUPT; }
  if (typeof name !== 'string') { process.stderr.write('xcg-proxy: --name is required\n'); process.stderr.write(USAGE); return EXIT_USAGE_OR_CORRUPT; }
  try { new URL(url); } catch { process.stderr.write(`xcg-proxy: invalid --url: ${url}\n`); return EXIT_USAGE_OR_CORRUPT; }

  // login termina (a diferencia de http, que vive en el event loop): salida
  // explícita en ambas ramas para no depender de que todos los handles
  // (server, transport) cierren limpiamente y Node salga por su cuenta.
  void runLogin({ url, name, scope })
    .then(() => process.exit(EXIT_OK))
    .catch((err: unknown) => {
      process.stderr.write(`xcg-proxy: login failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT_GENERIC_ERROR);
    });
  return null;
}

function dieUnknownSubcommand(arg: string | undefined): number {
  process.stderr.write(`xcg-proxy: unknown subcommand: ${arg ?? '(none)'}\n`);
  process.stderr.write(USAGE);
  return EXIT_USAGE_OR_CORRUPT;
}

export function main(argv: string[]): number | null {
  // Back-compat: pre-2.b wrap entries used the bare `--wrap ...` form with no
  // subcommand. Treat a leading `--wrap` as the stdio subcommand so config
  // entries written by old installs keep working after an upgrade (Hito 6).
  let normalized = argv;
  if (argv[0] === '--wrap') {
    process.stderr.write(
      'xcg-proxy: legacy --wrap invocation detected; still supported via a compatibility shim and may be removed in a future release.\n',
    );
    normalized = ['stdio', ...argv];
  }
  const subcommand = normalized[0];
  const rest = normalized.slice(1);
  switch (subcommand) {
    case 'stdio':
      return runStdioMain(rest);
    case 'http':
      return runHttpMain(rest);
    case 'login':
      return runLoginMain(rest);
    default:
      return dieUnknownSubcommand(subcommand);
  }
}
