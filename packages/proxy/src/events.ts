// EventSink: única superficie por la que main.ts emite eventos.
// Compone Writers (Fase 3: JsonlWriter; Fase 4 añadirá SocketWriter) sin que
// la firma de emit() cambie. Aplica truncamiento leaf-level a payloads de
// mcp.* events antes de pasar a los writers.

import { monotonicFactory, ulid } from 'ulid';

// `Direction` se define en @xcg/shared (contrato compartido del monorepo).
// Se re-exporta aquí porque events.ts es el módulo de tipos de evento del
// proxy: frame-processor.ts y latency.ts lo importan desde './events.js' en
// su calidad de tipo de evento, sin conocer la topología del monorepo.
// La fuente de verdad es @xcg/shared; este re-export es fachada explícita.
import type { Direction } from '@xcg/shared';
export type { Direction };

import type { Envelope, Writer } from './audit.js';
import type {
  DetectionBlock,
  DetectionEnrichment,
  EnrichmentSink,
} from './detection/types.js';
import type { ParseErrorReason, RpcId } from './parser.js';
import type { SocketDropReason } from './socket.js';
import type { NerDropReason } from './detection/ner/async-detector.js';

const MAX_LEAF_BYTES = 64 * 1024;

const nextId = monotonicFactory();

export type EventBody =
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
      kind:
        | 'spawn_failed'
        | 'parse_error'
        | 'unexpected'
        | 'http_connect_failed'
        | 'http_status_error'
        | 'oauth_failed';
      message: string;
      reason?: ParseErrorReason;
      frameSnippet?: string;
    }
  | {
      type: 'proxy.child_exited';
      code: number | null;
      signal: NodeJS.Signals | null;
      runtimeMs: number;
      framesIn: number;
      framesOut: number;
      framesStderr: number;
      framesInIncomplete: number;
      framesOutIncomplete: number;
    }
  | {
      type: 'proxy.shutdown';
      reason: 'child_exited' | 'parent_closed_stdin' | 'signal_received' | 'remote_closed';
      exitCode: number;
    }
  | {
      type: 'proxy.http_closed';
      runtimeMs: number;
      side: 'remote' | 'client';
      framesIn: number;
      framesOut: number;
    }
  | {
      type: 'proxy.socket_dropped';
      reason: SocketDropReason;
      message: string;
    }
  | {
      type: 'proxy.ner_dropped';
      reason: NerDropReason;
      jobId?: string;
      rpcId?: RpcId;
    }
  | {
      type: 'proxy.ner_worker_died';
      cause: 'exit' | 'error';
      pendingDropped: number;
    }
  | {
      type: 'mcp.request';
      direction: Direction;
      rpcId: RpcId;
      method: string;
      params: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
      detection?: DetectionBlock;
    }
  | {
      type: 'mcp.response';
      direction: Direction;
      rpcId: RpcId;
      result?: unknown;
      error?: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
      latencyMs?: number;
    }
  | {
      type: 'mcp.notification';
      direction: Direction;
      method: string;
      params: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
    }
  | {
      type: 'mcp.stderr';
      text: string;
      bytes: number;
      truncated?: true;
      overheadUs: number;
    }
  | {
      // Resultado de un detector off-path (NER) entregado por el orquestador
      // via EnrichmentSink. Append-only: no reescribe el mcp.request original;
      // el reader del Desktop lo correlaciona con su request por la terna
      // (session, rpcId, direction). overheadUs es la latencia de inferencia.
      type: 'mcp.detection_enrichment';
      rpcId: RpcId;
      direction: Direction;
      detection: DetectionBlock;
      overheadUs: number;
    };

/**
 * Leaf-level truncation: walks recursively. String leaves whose UTF-8 byte
 * size exceeds maxBytes are replaced by a marker; everything else passes through.
 * Returns the (possibly new) value and whether any leaf was truncated.
 */
export function truncate(
  value: unknown,
  maxBytes: number = MAX_LEAF_BYTES,
): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value, 'utf8');
    if (byteLen > maxBytes) {
      return { value: `[truncated ${byteLen} bytes]`, truncated: true };
    }
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let anyTruncated = false;
    const out = value.map((item) => {
      const r = truncate(item, maxBytes);
      if (r.truncated) anyTruncated = true;
      return r.value;
    });
    return { value: out, truncated: anyTruncated };
  }
  if (typeof value === 'object' && value !== null) {
    let anyTruncated = false;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const r = truncate(val, maxBytes);
      if (r.truncated) anyTruncated = true;
      out[key] = r.value;
    }
    return { value: out, truncated: anyTruncated };
  }
  return { value, truncated: false };
}

function applyTruncation(event: EventBody): EventBody {
  if (event.type === 'mcp.request' || event.type === 'mcp.notification') {
    const r = truncate(event.params);
    if (r.truncated) {
      return { ...event, params: r.value, truncated: true };
    }
    return event;
  }
  if (event.type === 'mcp.stderr') {
    const r = truncate(event.text);
    if (r.truncated) {
      return { ...event, text: r.value as string, truncated: true };
    }
    return event;
  }
  if (event.type === 'mcp.response') {
    let anyTruncated = false;
    let result = event.result;
    let error = event.error;
    if (result !== undefined) {
      const r = truncate(result);
      if (r.truncated) {
        result = r.value;
        anyTruncated = true;
      }
    }
    if (error !== undefined) {
      const r = truncate(error);
      if (r.truncated) {
        error = r.value;
        anyTruncated = true;
      }
    }
    if (anyTruncated) {
      return { ...event, result, error, truncated: true };
    }
    return event;
  }
  return event;
}

export class EventSink {
  constructor(
    private readonly mcp: string,
    private readonly writers: readonly Writer[] = [],
    private readonly session: string = ulid(),
  ) {}

  emit(event: EventBody): void {
    const finalEvent = applyTruncation(event);
    const envelope: Envelope = {
      v: 1,
      id: nextId(),
      ts: new Date().toISOString(),
      session: this.session,
      mcp: this.mcp,
      ...finalEvent,
    };
    for (const writer of this.writers) {
      writer.write(envelope);
    }
  }

  close(): void {
    for (const writer of this.writers) {
      writer.close();
    }
  }
}

// Adapter entre el contrato off-path (EnrichmentSink, consumido por el
// AsyncDetector segun @xcg/shared) y el productor JSONL del proxy. Asume
// worker per-wrapper (Modelo A de la cuestion c del NER): enrichment.session
// se ignora porque siempre coincide con el session del EventSink que arranco
// el proxy. Si en el futuro se multiplexa un worker entre wrappers (Modelo C),
// este adapter tendria que verificar la igualdad o indexar por session.
export function createEnrichmentSink(sink: EventSink): EnrichmentSink {
  return (enrichment) => {
    sink.emit({
      type: 'mcp.detection_enrichment',
      rpcId: enrichment.rpcId,
      direction: enrichment.direction,
      detection: enrichment.detection,
      overheadUs: enrichment.overheadUs,
    });
  };
}
