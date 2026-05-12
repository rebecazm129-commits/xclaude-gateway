// SocketWriter: best-effort ndjson sink hacia el stub del orquestador.
// Connect async no bloqueante; eventos durante el connecting se descartan
// silenciosamente (van solo al JSONL). Cualquier fallo del transport (connect,
// write, peer close) marca el writer como dead y notifica una sola vez vía
// onDrop, que main.ts traduce a un evento proxy.socket_dropped en el JSONL.
//
// INVARIANTE DE RECONEXIÓN (Fase 6): hoy esta clase no reintenta conectar
// nunca. Si en el futuro se añade reconexión, debe consultar el estado de
// shutdown del wrapper antes de intentar reconectar: si shuttingDown===true,
// la reconexión debe abortar inmediatamente. De lo contrario un connect a
// destiempo podría reabrir el socket entre socket.end() y el process.exit
// del flujo de gracefulShutdown.
// TODO(hito3): implementar reconexión con backoff y guard de shuttingDown.

import { createConnection, type Socket } from 'node:net';

import type { Envelope, Writer } from './audit.js';

export type SocketDropReason = 'connect_failed' | 'write_failed' | 'server_disconnected';
export type OnSocketDrop = (reason: SocketDropReason, message: string) => void;

type State = 'connecting' | 'connected' | 'dead';

export class SocketWriter implements Writer {
  private readonly socket: Socket;
  private readonly onDrop: OnSocketDrop;
  private state: State = 'connecting';

  constructor(socketPath: string, onDrop: OnSocketDrop) {
    this.onDrop = onDrop;
    this.socket = createConnection(socketPath);

    this.socket.once('connect', () => {
      if (this.state === 'connecting') {
        this.state = 'connected';
      }
    });

    this.socket.on('error', (err: Error) => {
      if (this.state === 'connecting') {
        this.markDead('connect_failed', err.message);
      } else if (this.state === 'connected') {
        this.markDead('write_failed', err.message);
      }
    });

    this.socket.on('close', () => {
      if (this.state === 'connected') {
        this.markDead('server_disconnected', 'socket closed by peer');
      }
    });
  }

  write(envelope: Envelope): void {
    if (this.state !== 'connected') return;
    try {
      this.socket.write(`${JSON.stringify(envelope)}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markDead('write_failed', message);
    }
  }

  /** True si la conexión está viva y aceptando writes. */
  isAlive(): boolean {
    return this.state === 'connected';
  }

  /**
   * Cierre graceful: emite FIN y resuelve cuando el peer cierra (o el socket
   * emite 'error' / 'close'). El caller envuelve esto en un timeout y, si
   * vence, invoca destroy(). Idempotente: si ya está dead, resuelve sin esperar.
   */
  async end(): Promise<void> {
    if (this.state === 'dead') return;
    const wasConnecting = this.state === 'connecting';
    this.state = 'dead';
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.socket.removeAllListeners();
        resolve();
      };
      this.socket.once('close', done);
      this.socket.once('error', done);
      if (wasConnecting) {
        // Sin conexión establecida no hay FIN que enviar; destruimos directo.
        this.socket.destroy();
      } else {
        this.socket.end();
      }
    });
  }

  /** Cierre inmediato sin half-close. Idempotente. */
  destroy(): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.socket.removeAllListeners();
    this.socket.destroy();
  }

  /** Alias preservado para la interfaz Writer. */
  close(): void {
    this.destroy();
  }

  private markDead(reason: SocketDropReason, message: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.socket.removeAllListeners();
    this.socket.destroy();
    this.onDrop(reason, message);
  }
}
