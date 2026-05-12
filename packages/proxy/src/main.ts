// Invariante MCP: el wrapper nunca escribe a stdout (reservado a frames JSON-RPC del MCP envuelto).
// Toda salida del wrapper (lifecycle events + errores) va a stderr.

import { spawn } from 'node:child_process';

import { EventSink } from './events.js';
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

function main(): void {
  const { wrap, name, childArgs } = parseArgs(process.argv.slice(2));
  const sink = new EventSink(name);
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
    process.exit(127);
  });

  child.on('spawn', () => {
    // child.pid is guaranteed defined once the 'spawn' event has fired.
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
    process.exit(1);
  }

  // Pass-through PRIMERO (registra el listener interno de pipe que escribe al destino).
  process.stdin.pipe(childStdin);
  childStdout.pipe(process.stdout, { end: false });
  childStderr.pipe(process.stderr, { end: false });

  // Observación DESPUÉS. EventEmitter llama listeners en orden de registro:
  // el pipe escribe a destino primero, nuestro contador toca el chunk después.
  const stdinSplitter = new LineSplitter();
  const stdoutSplitter = new LineSplitter();
  let framesIn = 0;
  let framesOut = 0;

  process.stdin.on('data', (chunk: Buffer) => {
    framesIn += stdinSplitter.feed(chunk).length;
  });

  childStdout.on('data', (chunk: Buffer) => {
    framesOut += stdoutSplitter.feed(chunk).length;
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

    if (signal !== null) {
      process.exit(128 + signalToNumber(signal));
    }
    process.exit(code ?? 0);
  });
}

main();
