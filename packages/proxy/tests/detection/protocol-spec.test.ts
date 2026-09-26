// protocol-spec.ts is a verbatim copy of the installed SDK's lists, on purpose
// (see its header). This is what keeps the copy honest: an SDK upgrade that
// adds, removes or reorders a method or a version fails here, and the update
// to what the tripwire considers normal becomes a deliberate edit rather than
// a side effect of `pnpm up`.

import { describe, expect, it } from 'vitest';
import {
  ClientNotificationSchema,
  ClientRequestSchema,
  LATEST_PROTOCOL_VERSION as SDK_LATEST,
  ServerNotificationSchema,
  ServerRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS as SDK_SUPPORTED,
} from '@modelcontextprotocol/sdk/types.js';

import {
  CLIENT_NOTIFICATION_METHODS,
  CLIENT_REQUEST_METHODS,
  LATEST_PROTOCOL_VERSION,
  SERVER_NOTIFICATION_METHODS,
  SERVER_REQUEST_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/detection/protocol-spec.js';

/** The `method` literal of every member of one of the SDK's message unions. */
function methodsOf(union: unknown): string[] {
  const options = (union as { options: { shape: { method: { _zod: { def: { values: unknown[] } } } } }[] })
    .options;
  return options.map((o) => {
    const values = o.shape.method._zod.def.values;
    if (values.length !== 1 || typeof values[0] !== 'string') {
      throw new Error(`expected a single string method literal, got ${JSON.stringify(values)}`);
    }
    return values[0];
  });
}

describe('protocol-spec — verbatim copy of the SDK', () => {
  it('client requests', () => {
    expect(CLIENT_REQUEST_METHODS).toEqual(methodsOf(ClientRequestSchema));
  });

  it('server requests', () => {
    expect(SERVER_REQUEST_METHODS).toEqual(methodsOf(ServerRequestSchema));
  });

  it('client notifications', () => {
    expect(CLIENT_NOTIFICATION_METHODS).toEqual(methodsOf(ClientNotificationSchema));
  });

  it('server notifications', () => {
    expect(SERVER_NOTIFICATION_METHODS).toEqual(methodsOf(ServerNotificationSchema));
  });

  it('protocol versions, in the SDK order', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(SDK_LATEST);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(SDK_SUPPORTED);
  });
});

describe('protocol-spec — deliberately absent', () => {
  // Their first appearance is the 2026-07-28 migration alarm. If either shows
  // up in these lists, the alarm has been switched off — decide it on purpose.
  it('server/discover is not a known client request', () => {
    expect(CLIENT_REQUEST_METHODS).not.toContain('server/discover');
  });

  it('2026-07-28 is not a known protocol version', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
  });
});
