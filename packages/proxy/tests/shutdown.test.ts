import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChildExitInfo, ShutdownDeps } from '../src/shutdown.js';
import {
  createGracefulShutdown,
  FSYNC_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../src/shutdown.js';

// Fake timers en TODOS los tests para que las setTimeouts de race() no
// queden colgando en el event loop ni alarguen los runs. Las pruebas que no
// avanzan el reloj se basan en microtasks ya resueltas.
//
// (La pata `socket` del harness y sus dos tests — skip con socket muerto y
// end-timeout→destroy — se retiraron el 17/07/2026 junto con el SocketWriter;
// git conserva ambos.)

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type StepName =
  | 'stdinEnd'
  | 'kill:SIGTERM'
  | 'kill:SIGKILL'
  | 'emitShutdown'
  | 'jsonl.fsync'
  | 'jsonl.close'
  | 'exit'
  | 'stderr';

interface Capture {
  step: StepName;
  payload?: unknown;
}

interface MockState {
  childAlive: boolean;
  childExitInfo: ChildExitInfo;
  childExit: Deferred<void>;
  fsync: Deferred<void>;
}

interface MockHarness {
  deps: ShutdownDeps;
  log: Capture[];
  state: MockState;
  killChild(info: ChildExitInfo): void;
}

function setup(initial: Partial<Pick<MockState, 'childAlive' | 'childExitInfo'>> = {}): MockHarness {
  const log: Capture[] = [];
  const state: MockState = {
    childAlive: initial.childAlive ?? true,
    childExitInfo: initial.childExitInfo ?? { code: null, signal: null },
    childExit: defer<void>(),
    fsync: defer<void>(),
  };

  const killChild = (info: ChildExitInfo): void => {
    state.childAlive = false;
    state.childExitInfo = info;
    state.childExit.resolve();
  };

  const deps: ShutdownDeps = {
    child: {
      stdinEnd: () => {
        log.push({ step: 'stdinEnd' });
      },
      kill: (signal) => {
        log.push({ step: `kill:${signal}` as StepName });
      },
      isAlive: () => state.childAlive,
      waitForExit: () => state.childExit.promise,
      exitInfo: () => state.childExitInfo,
    },
    jsonl: {
      fsync: () => {
        log.push({ step: 'jsonl.fsync' });
        return state.fsync.promise;
      },
      close: () => {
        log.push({ step: 'jsonl.close' });
      },
    },
    emitShutdown: (reason, exitCode) => {
      log.push({ step: 'emitShutdown', payload: { reason, exitCode } });
    },
    exit: (code) => {
      log.push({ step: 'exit', payload: code });
    },
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    stderr: (msg) => {
      log.push({ step: 'stderr', payload: msg });
    },
  };

  return { deps, log, state, killChild };
}

function stepsOnly(log: readonly Capture[]): StepName[] {
  return log.map((c) => c.step);
}

describe('createGracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('idempotencia: dos llamadas concurrentes devuelven el mismo Promise y el flujo corre una vez', async () => {
    const h = setup({ childAlive: false, childExitInfo: { code: 0, signal: null } });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);

    const p1 = shutdown('parent_closed_stdin');
    const p2 = shutdown('parent_closed_stdin');
    expect(p1).toBe(p2);

    await p1;

    expect(h.log.filter((c) => c.step === 'emitShutdown')).toHaveLength(1);
    expect(h.log.filter((c) => c.step === 'jsonl.close')).toHaveLength(1);
    expect(h.log.filter((c) => c.step === 'exit')).toHaveLength(1);

    // Una invocación posterior, ya completada: sigue devolviendo el mismo
    // promise resuelto sin re-ejecutar el flujo.
    const p3 = shutdown('parent_closed_stdin');
    expect(p3).toBe(p1);
    await p3;
    expect(h.log.filter((c) => c.step === 'exit')).toHaveLength(1);
  });

  it.each([
    {
      name: 'child vivo: incluye stdinEnd antes de emitShutdown',
      childAlive: true,
      preResolveChildExit: true,
      reason: 'parent_closed_stdin' as const,
      expected: [
        'stdinEnd',
        'emitShutdown',
        'jsonl.fsync',
        'jsonl.close',
        'exit',
      ] satisfies StepName[],
    },
    {
      name: 'child muerto: skip pasos 2-3, va directo a emitShutdown',
      childAlive: false,
      preResolveChildExit: false,
      reason: 'child_exited' as const,
      expected: [
        'emitShutdown',
        'jsonl.fsync',
        'jsonl.close',
        'exit',
      ] satisfies StepName[],
    },
  ])('orden de operaciones — $name', async ({ childAlive, preResolveChildExit, reason, expected }) => {
    const h = setup({
      childAlive,
      childExitInfo: { code: 0, signal: null },
    });
    if (preResolveChildExit) h.state.childExit.resolve();
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    await shutdown(reason);

    expect(stepsOnly(h.log)).toEqual(expected);
  });

  it('reason=child_exited code=0 → exit 0', async () => {
    const h = setup({ childAlive: false, childExitInfo: { code: 0, signal: null } });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    await shutdown('child_exited');

    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(0);
  });

  it('reason=child_exited code=1 → exit 1', async () => {
    const h = setup({ childAlive: false, childExitInfo: { code: 1, signal: null } });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    await shutdown('child_exited');

    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(1);
  });

  it('reason=child_exited signal=SIGSEGV → exit 139', async () => {
    const h = setup({
      childAlive: false,
      childExitInfo: { code: null, signal: 'SIGSEGV' },
    });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    await shutdown('child_exited');

    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(139);
  });

  it('reason=parent_closed_stdin con child limpio en grace → exit 0', async () => {
    const h = setup({ childAlive: true });
    h.state.childExit.resolve(); // childExit ya resuelto: race gana antes del SHUTDOWN_GRACE_MS
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    await shutdown('parent_closed_stdin');

    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(0);
    expect(stepsOnly(h.log)).not.toContain('kill:SIGTERM');
    expect(stepsOnly(h.log)).not.toContain('kill:SIGKILL');
  });

  it('reason=parent_closed_stdin con SIGKILL requerido → exit 1', async () => {
    const h = setup({ childAlive: true });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('parent_closed_stdin');

    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
    // Tras SIGKILL la función await waitForExit(): simulamos la muerte.
    h.killChild({ code: null, signal: 'SIGKILL' });

    await pending;

    expect(stepsOnly(h.log)).toContain('kill:SIGTERM');
    expect(stepsOnly(h.log)).toContain('kill:SIGKILL');
    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(1);
  });

  it('reason=signal_received con SIGKILL requerido → exit 1', async () => {
    const h = setup({ childAlive: true });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('signal_received');

    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
    h.killChild({ code: null, signal: 'SIGKILL' });

    await pending;

    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(1);
  });

  it('escalado A: child sale dentro de SHUTDOWN_GRACE_MS → no SIGTERM', async () => {
    const h = setup({ childAlive: true });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('parent_closed_stdin');

    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 100);
    h.killChild({ code: 0, signal: null });
    await pending;

    expect(stepsOnly(h.log)).not.toContain('kill:SIGTERM');
    expect(stepsOnly(h.log)).not.toContain('kill:SIGKILL');
    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(0);
  });

  it('escalado B: child sale tras SIGTERM dentro de SIGTERM_GRACE_MS → no SIGKILL', async () => {
    const h = setup({ childAlive: true });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('parent_closed_stdin');

    // Excede SHUTDOWN_GRACE_MS → dispara SIGTERM
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    expect(stepsOnly(h.log)).toContain('kill:SIGTERM');

    // Sale antes del SIGTERM_GRACE_MS → no SIGKILL
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - 100);
    h.killChild({ code: null, signal: 'SIGTERM' });
    await pending;

    expect(stepsOnly(h.log)).not.toContain('kill:SIGKILL');
    // neededSigkill=false → exitCode=0 para reason=parent_closed_stdin
    expect(h.log.find((c) => c.step === 'exit')?.payload).toBe(0);
  });

  it('escalado C: child nunca sale → SIGTERM seguido de SIGKILL', async () => {
    const h = setup({ childAlive: true });
    h.state.fsync.resolve();

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('signal_received');

    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    expect(stepsOnly(h.log)).toContain('kill:SIGTERM');

    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
    expect(stepsOnly(h.log)).toContain('kill:SIGKILL');

    h.killChild({ code: null, signal: 'SIGKILL' });
    await pending;
  });

  it('fsync nunca resuelve: tras FSYNC_TIMEOUT_MS continúa el flujo y stderr recibe el mensaje', async () => {
    const h = setup({
      childAlive: false,
      childExitInfo: { code: 0, signal: null },
    });
    // fsync deliberadamente sin resolver

    const shutdown = createGracefulShutdown(h.deps);
    const pending = shutdown('child_exited');

    await vi.advanceTimersByTimeAsync(FSYNC_TIMEOUT_MS);
    await pending;

    const stderrCalls = h.log.filter((c) => c.step === 'stderr');
    expect(stderrCalls).toHaveLength(1);
    expect(stderrCalls[0]!.payload).toMatch(/fsync timeout/);
    // Flujo continúa pese al timeout.
    expect(stepsOnly(h.log)).toContain('jsonl.close');
    expect(stepsOnly(h.log)).toContain('exit');
  });
});
