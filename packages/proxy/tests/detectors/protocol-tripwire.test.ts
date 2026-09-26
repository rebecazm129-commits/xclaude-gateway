// Protocol tripwire: the shape of a JSON-RPC request, never its content.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  protocolTripwire,
  resetProtocolTripwireForTests,
} from '../../src/detection/detectors/protocol-tripwire.js';
import type { DetectorInput, Direction } from '../../src/detection/types.js';

function req(method: string | null, direction: Direction, payload: unknown = undefined): DetectorInput {
  return {
    paramsJson: payload === undefined ? '' : JSON.stringify(payload),
    toolName: undefined,
    envelope: { payload, mcp: 'test-mcp', method, direction, sessionId: '01HXTESTSESSION' },
  };
}

const types = (input: DetectorInput): string[] => protocolTripwire(input)?.findings.map((f) => f.type) ?? [];

beforeEach(() => {
  resetProtocolTripwireForTests();
});

describe('protocolTripwire — server_request', () => {
  it('a server asking the client to run a model trips it, at medium', () => {
    const out = protocolTripwire(req('sampling/createMessage', 'server_to_client', { messages: [] }));
    expect(out).toEqual({
      category: 'protocol_tripwire',
      severity: 'medium',
      findings: [{ type: 'server_request', location: 'method' }],
    });
  });

  it('elicitation/create trips it too', () => {
    expect(types(req('elicitation/create', 'server_to_client', {}))).toEqual(['server_request']);
  });

  it('ping and roots/list from the server are expected: nothing', () => {
    expect(protocolTripwire(req('ping', 'server_to_client'))).toBeNull();
    expect(protocolTripwire(req('roots/list', 'server_to_client'))).toBeNull();
  });

  it('is NOT deduplicated: every server request is worth a look', () => {
    expect(types(req('sampling/createMessage', 'server_to_client', {}))).toEqual(['server_request']);
    expect(types(req('sampling/createMessage', 'server_to_client', {}))).toEqual(['server_request']);
  });

  it('a client request never trips it', () => {
    expect(protocolTripwire(req('tools/call', 'client_to_server', { name: 'x' }))).toBeNull();
  });
});

describe('protocolTripwire — unknown_method', () => {
  it('a client method outside the spec trips it, at low', () => {
    const out = protocolTripwire(req('server/discover', 'client_to_server'));
    expect(out).toEqual({
      category: 'protocol_tripwire',
      severity: 'low',
      findings: [{ type: 'unknown_method', location: 'method' }],
    });
  });

  it('a spec method in the WRONG direction is unknown for that direction', () => {
    // tools/call is a client request; a server sending it is not in the spec.
    expect(types(req('tools/call', 'server_to_client', {}))).toEqual(['server_request', 'unknown_method']);
    // roots/list is a server request; a client sending it is not.
    expect(types(req('roots/list', 'client_to_server'))).toEqual(['unknown_method']);
  });

  it('an unknown server method is both a server request and unknown; the severity is the max', () => {
    const out = protocolTripwire(req('custom/doSomething', 'server_to_client', {}));
    expect(out?.severity).toBe('medium');
    expect(out?.findings.map((f) => f.type)).toEqual(['server_request', 'unknown_method']);
  });

  it('deduplicates once per process per method and direction', () => {
    expect(types(req('server/discover', 'client_to_server'))).toEqual(['unknown_method']);
    expect(protocolTripwire(req('server/discover', 'client_to_server'))).toBeNull();
    // Another unknown method still trips…
    expect(types(req('vendor/extra', 'client_to_server'))).toEqual(['unknown_method']);
    // …and the same name from the other side is a different surprise.
    expect(types(req('server/discover', 'server_to_client'))).toEqual(['server_request', 'unknown_method']);
  });

  it('every spec client method passes', () => {
    for (const m of ['initialize', 'tools/list', 'tools/call', 'resources/read', 'prompts/get', 'ping']) {
      expect(protocolTripwire(req(m, 'client_to_server', {}))).toBeNull();
    }
  });

  it('a request without a method is not its business', () => {
    expect(protocolTripwire(req(null, 'client_to_server'))).toBeNull();
  });
});

describe('protocolTripwire — unknown_protocol_version', () => {
  it('reads initialize params.protocolVersion', () => {
    const out = protocolTripwire(req('initialize', 'client_to_server', { protocolVersion: '2026-07-28' }));
    expect(out).toEqual({
      category: 'protocol_tripwire',
      severity: 'low',
      findings: [{ type: 'unknown_protocol_version', location: 'params.protocolVersion' }],
    });
  });

  it('reads params._meta["io.modelcontextprotocol/protocolVersion"] on any request', () => {
    const payload = { name: 'x', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
    expect(protocolTripwire(req('tools/call', 'client_to_server', payload))?.findings).toEqual([
      { type: 'unknown_protocol_version', location: 'params._meta' },
    ]);
  });

  it('a known version, in either place, passes', () => {
    expect(protocolTripwire(req('initialize', 'client_to_server', { protocolVersion: '2025-11-25' }))).toBeNull();
    expect(protocolTripwire(req('initialize', 'client_to_server', { protocolVersion: '2025-03-26' }))).toBeNull();
    const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } };
    expect(protocolTripwire(req('tools/list', 'client_to_server', meta))).toBeNull();
  });

  it('protocolVersion outside initialize params is not read', () => {
    expect(protocolTripwire(req('tools/list', 'client_to_server', { protocolVersion: 'nonsense' }))).toBeNull();
  });

  it('a non-string version is unknown', () => {
    expect(types(req('initialize', 'client_to_server', { protocolVersion: 42 }))).toEqual([
      'unknown_protocol_version',
    ]);
  });

  it('deduplicates once per process per version, wherever it was declared', () => {
    expect(types(req('initialize', 'client_to_server', { protocolVersion: '2026-07-28' }))).toEqual([
      'unknown_protocol_version',
    ]);
    const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
    expect(protocolTripwire(req('tools/call', 'client_to_server', meta))).toBeNull();
    expect(types(req('initialize', 'client_to_server', { protocolVersion: '2099-01-01' }))).toEqual([
      'unknown_protocol_version',
    ]);
  });

  it('an unknown method carrying an unknown version reports both', () => {
    const payload = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
    expect(types(req('server/discover', 'client_to_server', payload))).toEqual([
      'unknown_method',
      'unknown_protocol_version',
    ]);
  });
});

describe('protocolTripwire — reset seam', () => {
  it('after a reset, the same unknown method trips again (a new process)', () => {
    expect(types(req('vendor/x', 'client_to_server'))).toEqual(['unknown_method']);
    resetProtocolTripwireForTests();
    expect(types(req('vendor/x', 'client_to_server'))).toEqual(['unknown_method']);
  });
});
