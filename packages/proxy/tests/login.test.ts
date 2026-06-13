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

// Shared DI-seam factory. By default transport.send RESOLVES (=> probeAuthorization
// returns false => !redirected) and discoverFn returns metadata ({}). Tests override
// per branch. The new rule under test: an explicit, non-empty scope routes through the
// auth-first branch (no initialize); absent scope keeps the existing flow.
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

describe('runLogin — explicit scope ⇒ auth-first (new branch)', () => {
  let errSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => { errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => { errSpy.mockRestore(); });

  // Test 1 — GitHub: the explicit catalog scope is what we authorize with, and the
  // initialize 401 (which would let the SDK request every PRM scope) never happens.
  it('GitHub: authorizes with the exact catalog scope, never the full PRM set, no initialize', async () => {
    const GH_URL = 'https://api.githubcopilot.com/mcp/';
    const GH_SCOPE = 'repo read:org read:user';
    const { deps, authFn, transport, callback, hasStored } = makeDeps();
    authFn.mockResolvedValue('REDIRECT');

    await runLogin({ url: GH_URL, name: 'github', scope: GH_SCOPE }, deps);

    // auth() driven directly, exactly once, with our narrow scope.
    expect(authFn).toHaveBeenCalledTimes(1);
    expect(authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: GH_URL, scope: GH_SCOPE });
    // initialize is never sent on the auth-first branch (so the SDK's 401-driven
    // internal auth — the one that would fall back to PRM scopes_supported — can't fire).
    expect(transport.send).not.toHaveBeenCalled();
    // hasStored belongs to the old flow; not consulted here.
    expect(hasStored).not.toHaveBeenCalled();
    // REDIRECT → loopback code → finishAuth.
    expect(callback.waitForCode).toHaveBeenCalledTimes(1);
    expect(transport.finishAuth).toHaveBeenCalledWith('test-code');

    // Negative assertion: the scope we sent contains NONE of the 12 PRM scopes beyond
    // the three we asked for — guards against ever requesting the full GitHub set.
    const sentScope = authFn.mock.calls[0]![1].scope as string;
    for (const wide of ['user:email', 'read:packages', 'write:packages', 'read:project',
      'project', 'gist', 'notifications', 'workflow', 'codespace']) {
      expect(sentScope).not.toContain(wide);
    }
  });

  it("auth()='AUTHORIZED' (stored/refreshed) → no callback wait, no finishAuth", async () => {
    const { deps, authFn, callback, transport } = makeDeps();
    authFn.mockResolvedValue('AUTHORIZED');
    await runLogin({ url: 'https://api.githubcopilot.com/mcp/', name: 'github', scope: 'repo' }, deps);
    expect(callback.waitForCode).not.toHaveBeenCalled();
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('via stored/refreshed credentials');
  });

  // Test 4 — explicit scope but the server advertises no PRM metadata: nothing to do.
  it('discovery undefined (404) → "no authorization required", auth() NOT called, clean return', async () => {
    const { deps, authFn, discoverFn, transport } = makeDeps();
    discoverFn.mockResolvedValue(undefined);
    await expect(
      runLogin({ url: 'https://example.test/mcp', name: 'github', scope: 'repo' }, deps),
    ).resolves.toBeUndefined();
    expect(authFn).not.toHaveBeenCalled();
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('no authorization required by server');
  });

  it('auth() throws → runLogin REJECTS, no false success', async () => {
    const { deps, authFn, transport } = makeDeps();
    authFn.mockRejectedValue(new Error('boom'));
    await expect(
      runLogin({ url: 'https://api.githubcopilot.com/mcp/', name: 'github', scope: 'repo' }, deps),
    ).rejects.toThrow('boom');
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).not.toContain('authorized');
  });

  it('discovery THROWS (network failure) → runLogin REJECTS, not "no authorization required"', async () => {
    const { deps, authFn, discoverFn } = makeDeps();
    discoverFn.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      runLogin({ url: 'https://api.githubcopilot.com/mcp/', name: 'github', scope: 'repo' }, deps),
    ).rejects.toThrow('fetch failed');
    expect(authFn).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).not.toContain('no authorization required');
  });

  it('empty-string scope is treated as absent → falls through to the existing flow', async () => {
    const { deps, authFn, hasStored, transport } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('AUTHORIZED');
    await runLogin({ url: 'https://mcp.atlassian.com/v1/mcp/authv2', name: 'atlassian', scope: '' }, deps);
    // Existing flow: initialize WAS sent (probe), then the deferred branch ran.
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: expect.anything(), scope: '' });
  });
});

describe('runLogin — no explicit scope ⇒ existing flow (unchanged)', () => {
  let errSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => { errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => { errSpy.mockRestore(); });

  // Test 2 — DCR connector (Atlassian), no scope: the initialize 401 path is intact.
  // send() throwing UnauthorizedError means the SDK already opened the browser; we wait
  // for the loopback code and finishAuth. auth() (our seam) is never called here.
  it('Atlassian (DCR, no scope): start→send→waitForCode→finishAuth, auth() NOT called', async () => {
    const ATL_URL = 'https://mcp.atlassian.com/v1/mcp/authv2';
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockRejectedValue(new UnauthorizedError('redirect')),
      finishAuth: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const callback = { waitForCode: vi.fn().mockResolvedValue('test-code'), close: vi.fn() };
    const authFn = vi.fn();
    const deps = {
      authFn, hasStored: vi.fn(), discoverFn: vi.fn().mockResolvedValue({}),
      createTransport: () => transport,
      startCallback: () => Promise.resolve(callback),
    };

    await runLogin({ url: ATL_URL, name: 'atlassian' }, deps);

    expect(authFn).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(callback.waitForCode).toHaveBeenCalledTimes(1);
    expect(transport.finishAuth).toHaveBeenCalledWith('test-code');
    // Order: start < send < waitForCode < finishAuth.
    const startOrder = transport.start.mock.invocationCallOrder[0]!;
    const sendOrder = transport.send.mock.invocationCallOrder[0]!;
    const waitOrder = callback.waitForCode.mock.invocationCallOrder[0]!;
    const finishOrder = transport.finishAuth.mock.invocationCallOrder[0]!;
    expect(startOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(waitOrder);
    expect(waitOrder).toBeLessThan(finishOrder);
  });

  // Test 3 — deferred path: a server WITHOUT scope that answers initialize 200 with no
  // stored token. probeAuthorization sees no redirect, discovery finds metadata, and the
  // existing deferred authFn(provider, { scope: undefined }) runs. NOTE: Gmail no longer
  // reaches this path — under the new rule its explicit scope routes it to the auth-first
  // branch. This test now models a generic no-scope deferred-auth server.
  it('deferred (initialize 200, no token, no scope): discovery + authFn via the existing path', async () => {
    const { deps, authFn, hasStored, discoverFn, callback, transport } = makeDeps();
    hasStored.mockResolvedValue(false);
    authFn.mockResolvedValue('REDIRECT');
    await runLogin({ url: 'https://deferred.test/mcp', name: 'deferred' }, deps);
    expect(transport.send).toHaveBeenCalledTimes(1); // initialize WAS probed
    expect(discoverFn).toHaveBeenCalledTimes(1);
    expect(authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: 'https://deferred.test/mcp', scope: undefined });
    expect(callback.waitForCode).toHaveBeenCalledTimes(1);
    expect(transport.finishAuth).toHaveBeenCalledWith('test-code');
  });

  it('initialize 200 + hasStored=true → no discovery, no auth(), "token still valid"', async () => {
    const { deps, authFn, hasStored, discoverFn, callback, transport } = makeDeps();
    hasStored.mockResolvedValue(true);
    await runLogin({ url: 'https://deferred.test/mcp', name: 'deferred' }, deps);
    expect(discoverFn).not.toHaveBeenCalled();
    expect(authFn).not.toHaveBeenCalled();
    expect(callback.waitForCode).not.toHaveBeenCalled();
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('token still valid');
  });

  it('deferred, no scope, discovery undefined → "no authorization required", auth() NOT called', async () => {
    const { deps, authFn, hasStored, discoverFn } = makeDeps();
    hasStored.mockResolvedValue(false);
    discoverFn.mockResolvedValue(undefined);
    await expect(runLogin({ url: 'https://deferred.test/mcp', name: 'deferred' }, deps)).resolves.toBeUndefined();
    expect(authFn).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('no authorization required by server');
  });
});
