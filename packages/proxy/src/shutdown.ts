// Shutdown limpio del wrapper (Fase 6).
//
// Tres causas legítimas de cierre: el padre cierra stdin, llega una señal,
// o el child muere por su cuenta. gracefulShutdown(reason) consolida los
// tres flujos en una secuencia única con persistencia garantizada del
// último evento (fsync) y propagación coherente del exit code.
//
// El módulo expone:
//   - Piezas puras: ShutdownReason, constantes de timeouts, computeExitCode.
//   - createGracefulShutdown(deps): factoría que devuelve la closure con
//     estado de shuttingDown encapsulado. Sin singleton: tests crean
//     instancias frescas.

export type ShutdownReason = 'parent_closed_stdin' | 'signal_received' | 'child_exited';

/** Ventana de espera entre child.stdin.end() y el envío de SIGTERM. */
export const SHUTDOWN_GRACE_MS = 2000;

/** Ventana de espera entre SIGTERM y SIGKILL. */
export const SIGTERM_GRACE_MS = 1000;

/** Timeout máximo del fsync sobre el JSONL antes de continuar. */
export const FSYNC_TIMEOUT_MS = 500;

/** Timeout máximo del socket.end() antes de pasar a destroy(). */
export const SOCKET_END_TIMEOUT_MS = 200;

/** Snapshot del último estado conocido del child para mapear exitCode. */
export interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Mapeo de señal Unix a número. Cubre las señales esperadas en cierres
 * legítimos o forzados; cualquier otra cae a 0, equivalente a "no signal".
 */
export function signalToNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case 'SIGHUP':
      return 1;
    case 'SIGINT':
      return 2;
    case 'SIGQUIT':
      return 3;
    case 'SIGKILL':
      return 9;
    case 'SIGSEGV':
      return 11;
    case 'SIGTERM':
      return 15;
    default:
      return 0;
  }
}

/**
 * Mapea (reason, neededSigkill, childExitInfo) → exitCode propagado por el
 * wrapper.
 *
 *  - child_exited: el wrapper hereda el cierre del child. Si el child salió
 *    por señal, convención Unix 128+N (SIGSEGV→139, SIGKILL→137, SIGTERM→143).
 *    En su defecto, code ?? 0.
 *  - parent_closed_stdin / signal_received: el wrapper decide el código.
 *    0 si el child cerró limpio dentro del grace; 1 si tuvimos que escalar
 *    hasta SIGKILL (cierre "sucio" desde la perspectiva del wrapper).
 */
export function computeExitCode(
  reason: ShutdownReason,
  neededSigkill: boolean,
  childExitInfo: ChildExitInfo,
): number {
  if (reason === 'child_exited') {
    if (childExitInfo.signal !== null) {
      return 128 + signalToNumber(childExitInfo.signal);
    }
    return childExitInfo.code ?? 0;
  }
  return neededSigkill ? 1 : 0;
}

/**
 * Dependencias inyectadas por main.ts. Cada método se mockea fácilmente
 * en tests sin necesidad de spawnar procesos ni abrir sockets reales.
 *
 *  - child.waitForExit: DEBE devolver siempre la misma Promise (cacheada en
 *    el adapter, resolved cuando child.on('exit') dispara). Permite re-await
 *    desde varios puntos del flujo sin bookkeeping.
 *  - child.isAlive: se consulta antes de stdin.end y antes de cada kill;
 *    si reason='child_exited' el guard inicial salta los pasos 2-3 enteros.
 *  - socket.isAlive: true sólo si el writer sigue 'connected'. Si está
 *    dead (incluyendo proxy.socket_dropped previo), saltamos end()/destroy().
 *  - delay: inyectable para usar vi.useFakeTimers() en los tests.
 */
export interface ShutdownDeps {
  child: {
    stdinEnd(): void;
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
    isAlive(): boolean;
    waitForExit(): Promise<void>;
    exitInfo(): ChildExitInfo;
  };
  socket: {
    isAlive(): boolean;
    end(): Promise<void>;
    destroy(): void;
  };
  jsonl: {
    fsync(): Promise<void>;
    close(): void;
  };
  emitShutdown(reason: ShutdownReason, exitCode: number): void;
  exit(code: number): void;
  delay(ms: number): Promise<void>;
  stderr(msg: string): void;
}

export type GracefulShutdown = (reason: ShutdownReason) => Promise<void>;

/**
 * Construye la closure gracefulShutdown(reason). El estado vive como
 * Promise cacheada en la closure, no como flag boolean: dos invocaciones
 * concurrentes reciben la misma Promise y ambas esperan al mismo cierre,
 * lo que preserva la semántica "esperar al cierre" para todos los callers
 * y simplifica el test de idempotencia.
 *
 * Orden de operaciones (los números coinciden con el plan de Fase 6):
 *   1. Guard idempotencia (Promise cacheada).
 *   2. child.stdin.end + race(waitForExit, SHUTDOWN_GRACE_MS).
 *   3. Escalado SIGTERM → SIGKILL si el child sigue vivo.
 *   4. computeExitCode(reason, neededSigkill, child.exitInfo()).
 *   5. (proxy.child_exited lo emite main.ts en su listener, no esta función.)
 *   6. emitShutdown(reason, exitCode) — JSONL siempre, socket sólo si vivo.
 *   7. socket.end() con timeout 200ms → destroy. Skip si !socket.isAlive().
 *   8. jsonl.fsync() con timeout 500ms → stderr 'fsync timeout, exiting anyway'.
 *   9. jsonl.close().
 *  10. exit(exitCode).
 */
export function createGracefulShutdown(deps: ShutdownDeps): GracefulShutdown {
  let shutdownPromise: Promise<void> | null = null;

  return function gracefulShutdown(reason: ShutdownReason): Promise<void> {
    // Paso 1
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async (): Promise<void> => {
      let neededSigkill = false;

      // Pasos 2-3: sólo si el child sigue vivo. Cuando reason='child_exited'
      // el listener de main.ts ya emitió child_exited antes de invocarnos,
      // así que isAlive()===false y saltamos directo al paso 4.
      if (deps.child.isAlive()) {
        // Paso 2
        deps.child.stdinEnd();
        const exitedCleanly = await Promise.race([
          deps.child.waitForExit().then(() => true),
          deps.delay(SHUTDOWN_GRACE_MS).then(() => false),
        ]);

        // Paso 3
        if (!exitedCleanly && deps.child.isAlive()) {
          deps.child.kill('SIGTERM');
          const exitedAfterTerm = await Promise.race([
            deps.child.waitForExit().then(() => true),
            deps.delay(SIGTERM_GRACE_MS).then(() => false),
          ]);

          if (!exitedAfterTerm && deps.child.isAlive()) {
            deps.child.kill('SIGKILL');
            await deps.child.waitForExit();
            neededSigkill = true;
          }
        }
      }

      // Paso 4
      const exitCode = computeExitCode(reason, neededSigkill, deps.child.exitInfo());

      // Paso 6: proxy.shutdown fluye por el EventSink; el SocketWriter ya
      // hace silent no-op si está dead, así que el chequeo socket.isAlive()
      // se usa sólo para decidir si vale la pena el end() graceful.
      deps.emitShutdown(reason, exitCode);

      // Paso 7
      if (deps.socket.isAlive()) {
        await Promise.race([
          deps.socket.end(),
          deps.delay(SOCKET_END_TIMEOUT_MS).then(() => deps.socket.destroy()),
        ]);
      }

      // Paso 8
      await Promise.race([
        deps.jsonl.fsync(),
        deps.delay(FSYNC_TIMEOUT_MS).then(() =>
          deps.stderr('[xcg] fsync timeout, exiting anyway\n'),
        ),
      ]);

      // Paso 9
      deps.jsonl.close();

      // Paso 10
      deps.exit(exitCode);
    })();

    return shutdownPromise;
  };
}
