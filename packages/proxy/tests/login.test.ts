// Unit tests for the loopback login helper (Hito 6 Fase 4 sub-step 4.c.1).
// interpretCallback is pure: no network, no spawn. runLogin's full happy-path
// (browser open + 5-min wait + finishAuth round-trip) is validated manually
// against the real remote in 4.c.2.

import { describe, it, expect } from 'vitest';

import { interpretCallback } from '../src/login.js';

const CALLBACK_PATH = '/xcg-callback';

describe('interpretCallback', () => {
  it('returns kind:"ignore" when the path does not match', () => {
    const url = new URL('http://127.0.0.1:51703/other?code=abc');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'ignore' });
  });

  it('returns kind:"code" when the callback path has ?code=...', () => {
    const url = new URL('http://127.0.0.1:51703/xcg-callback?code=AUTHCODE_123');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'code', code: 'AUTHCODE_123' });
  });

  it('returns kind:"error" when the callback path has ?error=...', () => {
    const url = new URL('http://127.0.0.1:51703/xcg-callback?error=access_denied');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'error', error: 'access_denied' });
  });

  it('returns kind:"error", error:"missing_code" when the callback path has neither code nor error', () => {
    const url = new URL('http://127.0.0.1:51703/xcg-callback');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'error', error: 'missing_code' });
  });

  it('error takes precedence over code (defense in depth)', () => {
    const url = new URL('http://127.0.0.1:51703/xcg-callback?code=abc&error=server_error');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'error', error: 'server_error' });
  });

  it('ignores trailing slashes / query-only differences on a non-matching path', () => {
    const url = new URL('http://127.0.0.1:51703/xcg-callback/?code=x');
    expect(interpretCallback(url, CALLBACK_PATH)).toEqual({ kind: 'ignore' });
  });
});
