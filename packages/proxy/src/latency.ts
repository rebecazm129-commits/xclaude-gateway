// InflightTracker: emparejamiento request↔response por (direction, rpcId).
// Puro y agnóstico al reloj — el consumidor pasa Date.now() (o el ts que prefiera)
// y recibe la diferencia tal cual. Sin TTL en Fase 5: requests que no reciben
// respuesta quedan acumulados hasta el cierre de la sesión; size() los expone
// para diagnóstico. Si Fase 8 muestra crecimiento problemático, se añade TTL.

import type { Direction } from './events.js';
import type { RpcId } from './parser.js';

export function invertDirection(d: Direction): Direction {
  return d === 'client_to_server' ? 'server_to_client' : 'client_to_server';
}

export class InflightTracker {
  private readonly pending = new Map<string, number>();

  trackRequest(direction: Direction, rpcId: RpcId, tsMs: number): void {
    // Duplicate (mismo direction+rpcId pre-respuesta): overwrite intencional.
    // El segundo es más reciente; cuando llegue el response, mide contra él.
    this.pending.set(this.key(direction, rpcId), tsMs);
  }

  matchResponse(
    direction: Direction,
    rpcId: RpcId,
    tsMs: number,
  ): number | undefined {
    const k = this.key(invertDirection(direction), rpcId);
    const start = this.pending.get(k);
    if (start === undefined) return undefined;
    this.pending.delete(k);
    // Latencia negativa (NTP step) se devuelve tal cual: anomalía real merece
    // visibilidad, no clamping silencioso.
    return tsMs - start;
  }

  size(): number {
    return this.pending.size;
  }

  private key(direction: Direction, rpcId: RpcId): string {
    return `${direction}:${rpcId}`;
  }
}
