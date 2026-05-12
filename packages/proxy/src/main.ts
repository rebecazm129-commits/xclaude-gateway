// Invariante MCP: el wrapper nunca escribe a stdout (reservado a frames JSON-RPC del MCP envuelto).
// Toda salida del wrapper va a stderr.

import { spawn } from 'node:child_process';

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
  // `name` se valida desde Fase 1 para fijar el contrato del launcher; su uso activo
  // (etiquetado de eventos) empieza en Fase 3.
  void name;

  const child = spawn(wrap, childArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  child.on('error', (err) => {
    process.stderr.write(`xcg-proxy: failed to spawn '${wrap}': ${err.message}\n`);
    process.exit(127);
  });

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    process.stderr.write('xcg-proxy: child pipes unavailable — internal error\n');
    process.exit(1);
  }

  // Pass-through transparente. Sin parseo, sin observación — Fase 1.
  // `{ end: false }` en los pipes child→parent evita intentar cerrar process.stdout/stderr
  // (son streams del propio proceso y no se cierran como pipes normales).
  process.stdin.pipe(childStdin);
  childStdout.pipe(process.stdout, { end: false });
  childStderr.pipe(process.stderr, { end: false });

  child.on('exit', (code, signal) => {
    if (signal !== null) {
      process.exit(128 + signalToNumber(signal));
    }
    process.exit(code ?? 0);
  });
}

main();
