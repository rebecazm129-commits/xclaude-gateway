// Unit tests for the loopback login helper (Hito 6 Fase 4 sub-step 4.c.1).
// interpretCallback is pure: no network, no spawn. runLogin's full happy-path
// (browser open + 5-min wait + finishAuth round-trip) is validated manually
// against the real remote in 4.c.2.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { interpretCallback, probeAuthorization, runLogin } from '../src/login.js';

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

describe('probeAuthorization', () => {
  it('returns false when send() resolves (token still valid → no redirect, no callback wait)', async () => {
    const send = vi.fn(() => Promise.resolve());
    await expect(probeAuthorization(send)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns true when send() throws UnauthorizedError (browser redirect happened → existing flow)', async () => {
    const send = vi.fn(() => Promise.reject(new UnauthorizedError('redirect')));
    await expect(probeAuthorization(send)).resolves.toBe(true);
  });

  it('rethrows a non-Unauthorized error (real discovery/DCR/network failure)', async () => {
    const send = vi.fn(() => Promise.reject(new Error('network down')));
    await expect(probeAuthorization(send)).rejects.toThrow('network down');
  });
});

describe('runLogin (deferred-auth branches via DI seam)', () => {
  const URL_ = 'https://gmailmcp.googleapis.com/mcp/v1';
  let errSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };

  beforeEach(() => { errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => { errSpy.mockRestore(); });

  // transport.send resolves => probeAuthorization returns false => !redirected.
  // discoverFn returns metadata ({}) by default => tests reach authFn unless overridden.
  function makeDeps(over: Record<string, unknown> = {}) {
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const callback = { waitForCode: vi.fn().mockResolvedValue('test-code'), close: vi.fn() };
    const authFn = vi.fn();
    const hasStored = vi.fn();
    const discoverFn = vi.fn().mockResolvedValue({}); // metadata present
    const deps = {
      authFn, hasStored, discoverFn,
      createTransport: () => transport,
      startCallback: () => Promise.resolve(callback),
      ...over,
    };
    return { deps, transport, callback, authFn, hasStored, discoverFn };
  }

  it('!redirected + hasStored=true → no discovery, no auth(), "token still valid"', async () => {
    const { deps, authFn, hasStored, discoverFn, callback, transport } = makeDeps();
    hasStored.mockResolvedValue(true);
    await runLogin({ url: URL_, name: 'gmail' }, deps);
    expect(discoverFn).not.toHaveBeenCalled();
    expect(authFn).not.toHaveBeenCalled();
    expect(callback.waitForCode).not.toHaveBeenCalled();
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('token still valid');
  });

  it('!redirected + no creds + discovery undefined (404) → "no authorization required", auth() NOT called', async () => {
    const { deps, authFn, hasStored, discoverFn } = makeDeps();
    hasStored.mockResolvedValue(false);
    discoverFn.mockResolvedValue(undefined);
    await expect(runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps)).resolves.toBeUndefined();
    expect(authFn).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('no authorization required by server');
  });

  it('discovery has metadata → auth() called with { serverUrl, scope }', async () => {
    const { deps, authFn, hasStored } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('AUTHORIZED');
    await runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps);
    expect(authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: URL_, scope: 'a b' });
  });

  it("auth()='REDIRECT' → waits for code and finishAuth", async () => {
    const { deps, authFn, hasStored, callback, transport } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('REDIRECT');
    await runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps);
    expect(callback.waitForCode).toHaveBeenCalledTimes(1);
    expect(transport.finishAuth).toHaveBeenCalledWith('test-code');
  });

  it("auth()='AUTHORIZED' → does NOT wait for a callback", async () => {
    const { deps, authFn, hasStored, callback, transport } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('AUTHORIZED');
    await runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps);
    expect(callback.waitForCode).not.toHaveBeenCalled();
    expect(transport.finishAuth).not.toHaveBeenCalled();
  });

  it('discovery has metadata + auth() throws → runLogin REJECTS, no false success', async () => {
    const { deps, authFn, hasStored, transport } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockRejectedValue(new Error('boom'));
    await expect(runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps)).rejects.toThrow('boom');
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).not.toContain('authorized');
  });

  it('discovery THROWS (network failure) → runLogin REJECTS, not "no authorization required"', async () => {
    const { deps, authFn, hasStored, discoverFn } = makeDeps();
    hasStored.mockResolvedValue(false);
    discoverFn.mockRejectedValue(new TypeError('fetch failed'));
    await expect(runLogin({ url: URL_, name: 'gmail', scope: 'a b' }, deps)).rejects.toThrow('fetch failed');
    expect(authFn).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).not.toContain('no authorization required');
  });

  it('scope absent → auth() called with scope undefined (retrocompat)', async () => {
    const { deps, authFn, hasStored } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('AUTHORIZED');
    await runLogin({ url: URL_, name: 'gmail' }, deps);
    expect(authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: URL_, scope: undefined });
  });
});
