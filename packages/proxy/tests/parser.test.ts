import { describe, it, expect } from 'vitest';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { classify, classifyFromMessage } from '../src/parser.js';

describe('classify — request', () => {
  it('classifies a valid numeric-id request with params', () => {
    expect(classify('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}')).toEqual({
      kind: 'request',
      id: 1,
      method: 'tools/call',
      params: { name: 'x' },
    });
  });

  it('accepts string id without params', () => {
    expect(classify('{"jsonrpc":"2.0","id":"abc","method":"init"}')).toEqual({
      kind: 'request',
      id: 'abc',
      method: 'init',
      params: undefined,
    });
  });

  it('accepts null id (spec-discouraged but legal)', () => {
    const r = classify('{"jsonrpc":"2.0","id":null,"method":"x"}');
    expect(r.kind).toBe('request');
    if (r.kind === 'request') expect(r.id).toBeNull();
  });
});

describe('classify — response', () => {
  it('classifies a response with result', () => {
    expect(classify('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
      kind: 'response',
      id: 1,
      result: { ok: true },
    });
  });

  it('classifies a response with error', () => {
    expect(classify('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"bad"}}')).toEqual({
      kind: 'response',
      id: 1,
      error: { code: -32000, message: 'bad' },
    });
  });

  it('classifies response with both result and error (spec-violating, pass-through)', () => {
    expect(classify('{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":-1,"message":"x"}}')).toEqual({
      kind: 'response',
      id: 1,
      result: 1,
      error: { code: -1, message: 'x' },
    });
  });

  it('classifies response with id:null (error response to invalid request)', () => {
    const r = classify('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}');
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(r.id).toBeNull();
  });
});

describe('classify — notification', () => {
  it('classifies a notification without id', () => {
    expect(classify('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({
      kind: 'notification',
      method: 'notifications/initialized',
      params: undefined,
    });
  });

  it('classifies notification with array params', () => {
    expect(classify('{"jsonrpc":"2.0","method":"x","params":[1,2]}')).toEqual({
      kind: 'notification',
      method: 'x',
      params: [1, 2],
    });
  });
});

describe('classify — parse errors', () => {
  it('invalid_json on malformed JSON', () => {
    expect(classify('{')).toEqual({ kind: 'parse_error', reason: 'invalid_json' });
  });

  it('not_an_object on JSON-RPC batch (array)', () => {
    expect(classify('[{"jsonrpc":"2.0","method":"x"}]')).toEqual({
      kind: 'parse_error',
      reason: 'not_an_object',
    });
  });

  it('not_an_object on null literal', () => {
    expect(classify('null')).toEqual({ kind: 'parse_error', reason: 'not_an_object' });
  });

  it('not_an_object on primitive', () => {
    expect(classify('42')).toEqual({ kind: 'parse_error', reason: 'not_an_object' });
  });

  it('missing_jsonrpc_2_0 when jsonrpc field absent', () => {
    expect(classify('{"id":1,"method":"x"}')).toEqual({
      kind: 'parse_error',
      reason: 'missing_jsonrpc_2_0',
    });
  });

  it('missing_jsonrpc_2_0 on wrong version', () => {
    expect(classify('{"jsonrpc":"1.0","method":"x"}')).toEqual({
      kind: 'parse_error',
      reason: 'missing_jsonrpc_2_0',
    });
  });

  it('malformed_jsonrpc on invalid id type (object)', () => {
    expect(classify('{"jsonrpc":"2.0","id":{"obj":true},"method":"x"}')).toEqual({
      kind: 'parse_error',
      reason: 'malformed_jsonrpc',
    });
  });

  it('malformed_jsonrpc on id present without method/result/error', () => {
    expect(classify('{"jsonrpc":"2.0","id":1}')).toEqual({
      kind: 'parse_error',
      reason: 'malformed_jsonrpc',
    });
  });

  it('malformed_jsonrpc on response shape without id (result only)', () => {
    expect(classify('{"jsonrpc":"2.0","result":{}}')).toEqual({
      kind: 'parse_error',
      reason: 'malformed_jsonrpc',
    });
  });

  it('malformed_jsonrpc on non-string method', () => {
    expect(classify('{"jsonrpc":"2.0","method":42}')).toEqual({
      kind: 'parse_error',
      reason: 'malformed_jsonrpc',
    });
  });
});

describe('classifyFromMessage — http/sse path producer (Fase 2)', () => {
  it('request: method + id + params → kind:request, claves intactas', () => {
    const msg: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo' },
    } as JSONRPCMessage;
    expect(classifyFromMessage(msg)).toEqual({
      kind: 'request',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo' },
    });
  });

  it('notification: method SIN id → kind:notification', () => {
    const msg: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    } as JSONRPCMessage;
    const out = classifyFromMessage(msg);
    expect(out.kind).toBe('notification');
    if (out.kind !== 'notification') return;
    expect(out.method).toBe('notifications/initialized');
    expect(out.params).toBeUndefined();
  });

  it('response.result → kind:response con result, SIN clave error', () => {
    const msg: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 42,
      result: { ok: true },
    } as JSONRPCMessage;
    const out = classifyFromMessage(msg);
    expect(out).toEqual({ kind: 'response', id: 42, result: { ok: true } });
    // CRÍTICO: la clave 'error' NO debe aparecer (ni como undefined).
    expect('error' in out).toBe(false);
  });

  it('response.error → kind:response con error, SIN clave result', () => {
    const msg: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32601, message: 'method not found' },
    } as JSONRPCMessage;
    const out = classifyFromMessage(msg);
    expect(out.kind).toBe('response');
    if (out.kind !== 'response') return;
    expect(out.id).toBe(42);
    expect(out.error).toEqual({ code: -32601, message: 'method not found' });
    // CRÍTICO: la clave 'result' NO debe aparecer (ni como undefined).
    expect('result' in out).toBe(false);
  });

  it('response.error SIN id (huérfana) → id:null', () => {
    const msg = {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'parse error' },
    } as unknown as JSONRPCMessage;
    const out = classifyFromMessage(msg);
    expect(out.kind).toBe('response');
    if (out.kind !== 'response') return;
    expect(out.id).toBeNull();
    expect('result' in out).toBe(false);
  });

  it('request con string id → preservado', () => {
    const msg: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 'abc',
      method: 'ping',
    } as JSONRPCMessage;
    const out = classifyFromMessage(msg);
    expect(out.kind).toBe('request');
    if (out.kind !== 'request') return;
    expect(out.id).toBe('abc');
    expect(out.params).toBeUndefined();
  });

  it('paridad con classify(line) en frames bien formados', () => {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 42, result: { ok: true } },
      { jsonrpc: '2.0', id: 42, error: { code: -32601, message: 'x' } },
    ];
    for (const f of frames) {
      expect(classifyFromMessage(f as unknown as JSONRPCMessage))
        .toEqual(classify(JSON.stringify(f)));
    }
  });
});
