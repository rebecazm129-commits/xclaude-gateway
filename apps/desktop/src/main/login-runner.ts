// Login IO layer (Hito 6 Fase 5, Pieza A) — the side-effecting half of the
// remote-connector flow. Spawns the real `xcg-proxy login` subcommand and
// resolves by EXIT CODE (unlike selftest-runner, which resolves on a stderr
// bootstrap line and treats exit as failure).
//
// This module is deliberately NOT a pure handler: it spawns a process. The pure
// orchestrator (connect-handler.ts) injects this function as a seam and is
// unit-tested with a mock. The login subcommand writes everything to stderr
// (the authorization URL and the success message) and opens the browser itself;
// it exits 0 on success, 2 on bad args, 1 (or a signal) on timeout/OAuth/spawn
// failure. Every outcome — including failure — is data: the Promise never
// rejects.

import { spawn } from 'node:child_process';

export type LoginOutcome =
  | { kind: 'success' }
  | { kind: 'invalid-args'; detail: string }
  | { kind: 'failed'; detail: string };

export interface LoginProcessOptions {
  /** Real proxy binary path (from resolveXcgTargetPathFromMain()). */
  readonly proxyBinPath: string;
  readonly url: string;
  readonly name: string;
  /** Backstop timeout, larger than the binary's own 5-min callback timeout. */
  readonly timeoutMs: number;
}

export async function runLoginProcess(opts: LoginProcessOptions): Promise<LoginOutcome> {
  const child = spawn(
    opts.proxyBinPath,
    ['login', '--url', opts.url, '--name', opts.name],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  return await new Promise<LoginOutcome>((resolve) => {
    let settled = false;
    const stderrAll: string[] = [];
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onStderr = (chunk: Buffer): void => {
      stderrAll.push(chunk.toString());
    };

    const onExit = (code: number | null, _signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ kind: 'success' });
      } else if (code === 2) {
        resolve({ kind: 'invalid-args', detail: stderrAll.join('') });
      } else {
        resolve({ kind: 'failed', detail: stderrAll.join('') });
      }
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: 'failed', detail: `failed to spawn login: ${err.message}` });
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      resolve({
        kind: 'failed',
        detail: `login process did not exit after ${opts.timeoutMs}ms; stderr:\n${stderrAll.join('')}`,
      });
    }, opts.timeoutMs);

    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}
