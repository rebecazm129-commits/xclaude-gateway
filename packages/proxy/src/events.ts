// EventSink: única superficie por la que main.ts emite eventos.
// Fase 2: escribe ndjson a stderr.
// Fase 3+: añadirá JSONL per-session + socket sin cambiar la firma de emit().
//
// Envelope canónico: v, ts, session, mcp, type, ...payload propio del evento.
// `id` (ULID) entra en Fase 3 cuando llegue la lib; el resto de campos
// estabiliza desde aquí.

import { randomUUID } from 'node:crypto';

export type LifecycleEvent =
  | {
      type: 'proxy.started';
      pid: number;
      wrap: string;
      wrappedArgs: readonly string[];
    }
  | {
      type: 'proxy.child_spawned';
      childPid: number;
    }
  | {
      type: 'proxy.error';
      kind: 'spawn_failed' | 'unexpected';
      message: string;
    }
  | {
      type: 'proxy.child_exited';
      code: number | null;
      signal: NodeJS.Signals | null;
      runtimeMs: number;
      framesIn: number;
      framesOut: number;
      framesInIncomplete: number;
      framesOutIncomplete: number;
    }
  | {
      type: 'proxy.shutdown';
      reason: 'child_exited' | 'parent_closed_stdin' | 'signal_received';
    };

export class EventSink {
  private readonly session = randomUUID();

  constructor(private readonly mcp: string) {}

  emit(event: LifecycleEvent): void {
    const envelope = {
      v: 1 as const,
      ts: new Date().toISOString(),
      session: this.session,
      mcp: this.mcp,
      ...event,
    };
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  }
}
