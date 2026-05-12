// Invariante MCP: el wrapper nunca escribe a stdout (reservado a frames JSON-RPC del MCP envuelto).
// La única salida del wrapper a stderr es: la bootstrap line al arrancar y errores fatales pre-sink.
// Los eventos canónicos del wrapper van al JSONL per-sesión vía EventSink.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { JsonlWriter } from './audit.js';
import { EventSink, type Direction, type EventBody } from './events.js';
import { classify, type ClassifiedFrame } from './parser.js';
import { SocketWriter } from './socket.js';
import { resolveSocketPath } from './socket-path.js';
import { LineSplitter } from './splitter.js';

interface ParsedArgs {
  wrap: string;
  name: string;
  childArgs: readonly string[];
}

function die(message: string): never {
  process.stderr.write(`xcg-proxy: ${message}\n`);
  process.stderr.write('usage: xcg-proxy --wrap <command> --name <id> -- [args...]\n');
  process.exit(2);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let wrap: string | undefined;
  let name: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--wrap') {
      const value = argv[i + 1];
      if (value === undefined) die('--wrap requires a value');
      wrap = value;
      i += 2;
      continue;
    }
    if (arg === '--name') {
      const value = argv[i + 1];
      if (value === undefined) die('--name requires a value');
      name = value;
      i += 2;
      continue;
    }
    if (arg === '--') {
      i += 1;
      break;
    }
    die(`unexpected argument: ${arg}`);
  }
  if (wrap === undefined) die('--wrap is required');
  if (name === undefined) die('--name is required');
  return { wrap, name, childArgs: argv.slice(i) };
}

function signalToNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case 'SIGTERM':
      return 15;
    case 'SIGKILL':
      return 9;
    case 'SIGINT':
      return 2;
    case 'SIGHUP':
      return 1;
    default:
      return 0;
  }
}

function buildFrameEvent(
  frame: ClassifiedFrame,
  direction: Direction,
  bytes: number,
  line: string,
): EventBody {
  switch (frame.kind) {
    case 'request':
      return {
        type: 'mcp.request',
        direction,
        rpcId: frame.id,
        method: frame.method,
        params: frame.params,
        bytes,
      };
    case 'response':
      return {
        type: 'mcp.response',
        direction,
        rpcId: frame.id,
        bytes,
        ...('result' in frame ? { result: frame.result } : {}),
        ...('error' in frame ? { error: frame.error } : {}),
      };
    case 'notification':
      return {
        type: 'mcp.notification',
        direction,
        method: frame.method,
        params: frame.params,
        bytes,
      };
    case 'parse_error':
      return {
        type: 'proxy.error',
        kind: 'parse_error',
        message: `MCP frame parse error: ${frame.reason}`,
        reason: frame.reason,
        frameSnippet: line.length > 256 ? line.slice(0, 256) : line,
      };
  }
}

function main(): void {
  const { wrap, name, childArgs } = parseArgs(process.argv.slice(2));

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
  process.stdin.pipe(childStdin);
  childStdout.pipe(process.stdout, { end: false });
  childStderr.pipe(process.stderr, { end: false });

  const stdinSplitter = new LineSplitter();
  const stdoutSplitter = new LineSplitter();
  let framesIn = 0;
  let framesOut = 0;

  process.stdin.on('data', (chunk: Buffer) => {
    const lines = stdinSplitter.feed(chunk);
    framesIn += lines.length;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1; // +1 por el \n consumido por el splitter
      sink.emit(buildFrameEvent(classify(line), 'client_to_server', bytes, line));
    }
  });

  childStdout.on('data', (chunk: Buffer) => {
    const lines = stdoutSplitter.feed(chunk);
    framesOut += lines.length;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      sink.emit(buildFrameEvent(classify(line), 'server_to_client', bytes, line));
    }
  });

  let shutdownReason: 'child_exited' | 'parent_closed_stdin' | 'signal_received' =
    'child_exited';

  process.stdin.on('end', () => {
    shutdownReason = 'parent_closed_stdin';
  });

  child.on('exit', (code, signal) => {
    sink.emit({
      type: 'proxy.child_exited',
      code,
      signal,
      runtimeMs: Date.now() - startMs,
      framesIn,
      framesOut,
      framesInIncomplete: stdinSplitter.incompleteBytes(),
      framesOutIncomplete: stdoutSplitter.incompleteBytes(),
    });
    sink.emit({ type: 'proxy.shutdown', reason: shutdownReason });
    sink.close();

    if (signal !== null) {
      process.exit(128 + signalToNumber(signal));
    }
    process.exit(code ?? 0);
  });
}

main();
