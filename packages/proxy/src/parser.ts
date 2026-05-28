// JSON-RPC 2.0 classifier per MCP spec.
// Pure function — no state, no I/O. Returns a discriminated union;
// the call site forwards the raw line to its destination regardless
// of classification — parse errors do not block pass-through.

// `RpcId` se define en @xcg/shared (contrato compartido del monorepo).
// Se re-exporta aquí porque parser.ts es donde nace el tipo para el proxy:
// latency.ts y events.ts lo importan desde './parser.js' sin conocer la
// topología del monorepo. La fuente de verdad es @xcg/shared; fachada explícita.
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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

// --- HTTP/SSE path producer (Hito 6 Fase 2) ----------------------------------
//
// classifyFromMessage(msg): ClassifiedFrame
//
// Segundo productor de ClassifiedFrame, en paralelo a classify(line). El SDK
// (StreamableHTTPClientTransport) entrega onmessage(msg: JSONRPCMessage) ya
// parseado y validado — no hay JSON.parse aquí, ni se ve la representación
// textual del frame (eso lo gestiona el call-site HTTP de Fase 3 si necesita
// un `line` para frame-processor).
//
// La discriminación replica la de classify(line) pero sobre el objeto:
//   - method  +  id  → request
//   - method  + ¬id  → notification
//   - ¬method + (result | error) → response
// parse_error NO se emite por este path: el SDK valida al parsear, así que
// cualquier ill-formed message muere antes de llegar aquí.
//
// Compatibilidad con frame-processor.ts: la construcción usa asignación
// condicional (objeto literal con la clave solo cuando corresponde), así que
// NUNCA se introduce una clave con valor undefined. El operador `in` que usa
// frame-processor sobre `result`/`error` devuelve la respuesta correcta
// (presente vs ausente).
//
// Edge — JSONRPCErrorResponse permite id ausente (spec): si la respuesta no
// trae id (servidor no pudo asociarla a una request — error pre-parse), se
// mapea a id: null, que el tipo RpcId del proxy permite.
//
// Divergencia intencional con classify(line): una error-response sin `id`
// que classify marcaría como parse_error('malformed_jsonrpc') aquí se mapea
// a response{ id: null }, que es la lectura correcta de JSON-RPC. El SDK ya
// valida, así que parse_error no aplica a este path.
export function classifyFromMessage(msg: JSONRPCMessage): ClassifiedFrame {
  if ('method' in msg) {
    if ('id' in msg) {
      return {
        kind: 'request',
        id: (msg as { id: RpcId }).id,
        method: (msg as { method: string }).method,
        params: (msg as { params?: unknown }).params,
      };
    }
    return {
      kind: 'notification',
      method: (msg as { method: string }).method,
      params: (msg as { params?: unknown }).params,
    };
  }
  // No method → response (result | error). id puede faltar en ErrorResponse.
  const id: RpcId = 'id' in msg ? ((msg as { id?: RpcId }).id ?? null) : null;
  if ('result' in msg) {
    return { kind: 'response', id, result: (msg as { result: unknown }).result };
  }
  return { kind: 'response', id, error: (msg as { error: unknown }).error };
}
