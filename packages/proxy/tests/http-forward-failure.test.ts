// Bridge http: a send() rejection must ANSWER the in-flight request instead of
// leaving its id dangling. Regression for the 27/08 Notion hang, where every
// tools/call after a token refresh hit
//   StreamableHTTPError(401, 'Server returned 401 after successful authentication')
// (the SDK's auth circuit breaker), was written to stderr only, and Claude
// Desktop waited out its own 4-minute timeout with no error surfaced.
//
// runHttp is not exported and owns heavy IO (Keychain, JsonlWriter, NER
// worker), so the decision is tested through the two pure helpers it delegates
// to — the pure/IO split this package already uses (cchook-ingest, manifest).

import { describe, it, expect } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { FORWARD_FAILED_CODE, forwardFailureResponse, isAuthError } from '../src/main.js';
import { ReauthRequiredError } from '../src/oauth-provider.js';

// Shape of the frames that hung: tools/call with a numeric id.
const request = (id: number): JSONRPCMessage =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'notion-fetch' } }) as JSONRPCMessage;

const notification = (): JSONRPCMessage =>
  ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } }) as JSONRPCMessage;

// (i) the 401 circuit breaker and (ii) a plain upstream 500.
const err401 = new StreamableHTTPError(401, 'Server returned 401 after successful authentication');
const err500 = new StreamableHTTPError(500, 'Error POSTing to endpoint: boom');

describe('http bridge: forward failure answers the client', () => {
  it('(i) 401 → JSONRPCError with the request id', () => {
    const res = forwardFailureResponse(request(4), err401);
    expect(res).not.toBeNull();
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: FORWARD_FAILED_CODE,
        message:
          'xcg-proxy: forward to remote failed: Streamable HTTP error: Server returned 401 after successful authentication',
      },
    });
  });

  it('(ii) 500 → JSONRPCError with the request id', () => {
    const res = forwardFailureResponse(request(7), err500);
    expect(res).not.toBeNull();
    expect(res?.id).toBe(7);
    expect(res?.error.code).toBe(FORWARD_FAILED_CODE);
    expect(res?.error.message).toContain('Error POSTing to endpoint: boom');
  });

  it('the id is echoed verbatim, never invented', () => {
    expect(forwardFailureResponse(request(0), err500)?.id).toBe(0);
    expect(forwardFailureResponse(request(42), err401)?.id).toBe(42);
  });

  it('notifications get no response (no id to answer)', () => {
    expect(forwardFailureResponse(notification(), err500)).toBeNull();
  });

  it('the code sits in the JSON-RPC implementation-defined server range', () => {
    expect(FORWARD_FAILED_CODE).toBeGreaterThanOrEqual(-32099);
    expect(FORWARD_FAILED_CODE).toBeLessThanOrEqual(-32000);
  });
});

describe('http bridge: only 401 takes the auth_failed branch', () => {
  it('(i) StreamableHTTPError 401 is an auth error', () => {
    expect(isAuthError(err401)).toBe(true);
  });

  it('(ii) StreamableHTTPError 500 is NOT an auth error', () => {
    expect(isAuthError(err500)).toBe(false);
  });

  it('a connection failure (no numeric code) is NOT an auth error', () => {
    expect(isAuthError(new TypeError('fetch failed'))).toBe(false);
  });

  it('the pre-existing auth errors still classify as auth', () => {
    expect(isAuthError(new UnauthorizedError())).toBe(true);
    expect(isAuthError(new ReauthRequiredError('notion'))).toBe(true);
  });
});
