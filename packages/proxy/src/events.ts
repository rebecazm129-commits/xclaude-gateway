// EventSink: única superficie por la que main.ts emite eventos.
// Compone Writers (Fase 3: JsonlWriter; Fase 4 añadirá SocketWriter) sin que
// la firma de emit() cambie. Aplica truncamiento leaf-level a payloads de
// mcp.* events antes de pasar a los writers.

import { monotonicFactory, ulid } from 'ulid';

import type { Envelope, Writer } from './audit.js';
import type { DetectionBlock } from './detection/types.js';
import type { ParseErrorReason, RpcId } from './parser.js';
import type { SocketDropReason } from './socket.js';

const MAX_LEAF_BYTES = 64 * 1024;

const nextId = monotonicFactory();

export type Direction = 'client_to_server' | 'server_to_client';

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
      kind: 'spawn_failed' | 'parse_error' | 'unexpected';
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
      reason: 'child_exited' | 'parent_closed_stdin' | 'signal_received';
      exitCode: number;
    }
  | {
      type: 'proxy.socket_dropped';
      reason: SocketDropReason;
      message: string;
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
