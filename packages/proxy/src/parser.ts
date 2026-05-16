// JSON-RPC 2.0 classifier per MCP spec.
// Pure function — no state, no I/O. Returns a discriminated union;
// the call site forwards the raw line to its destination regardless
// of classification — parse errors do not block pass-through.

// `RpcId` se define en @xcg/shared (contrato compartido del monorepo).
// Se re-exporta aquí porque parser.ts es donde nace el tipo para el proxy:
// latency.ts y events.ts lo importan desde './parser.js' sin conocer la
// topología del monorepo. La fuente de verdad es @xcg/shared; fachada explícita.
import type { RpcId } from '@xcg/shared';
export type { RpcId };

export type ParseErrorReason =
  | 'invalid_json'
  | 'not_an_object'
  | 'missing_jsonrpc_2_0'
  | 'malformed_jsonrpc';

export type ClassifiedFrame =
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  | { kind: 'response'; id: RpcId; result?: unknown; error?: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'parse_error'; reason: ParseErrorReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

export function classify(line: string): ClassifiedFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'parse_error', reason: 'invalid_json' };
  }

  if (!isPlainObject(parsed)) {
    return { kind: 'parse_error', reason: 'not_an_object' };
  }

  if (parsed.jsonrpc !== '2.0') {
    return { kind: 'parse_error', reason: 'missing_jsonrpc_2_0' };
  }

  const method = parsed.method;

  if ('id' in parsed) {
    const id = parsed.id;
    if (!isRpcId(id)) {
      return { kind: 'parse_error', reason: 'malformed_jsonrpc' };
    }
    if (typeof method === 'string') {
      return { kind: 'request', id, method, params: parsed.params };
    }
    if ('result' in parsed || 'error' in parsed) {
      const extras: { result?: unknown; error?: unknown } = {};
      if ('result' in parsed) extras.result = parsed.result;
      if ('error' in parsed) extras.error = parsed.error;
      return { kind: 'response', id, ...extras };
    }
    return { kind: 'parse_error', reason: 'malformed_jsonrpc' };
  }

  if (typeof method === 'string') {
    return { kind: 'notification', method, params: parsed.params };
  }

  return { kind: 'parse_error', reason: 'malformed_jsonrpc' };
}
