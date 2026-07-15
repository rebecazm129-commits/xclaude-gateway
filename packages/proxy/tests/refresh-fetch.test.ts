// Unit tests for the refresh single-flight interceptor (refresh-fetch.ts).
// keychain.js is mocked with an in-memory Map SHARED across provider/interceptor
// instances — that shared store is what simulates two wrapper processes of the
// same connector seeing the same Keychain. Locks run against a real temp dir
// (true O_EXCL semantics; that's the cross-process seam under test).

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

vi.mock('../src/keychain.js', () => ({
  keychainSet: async (account: string, value: string): Promise<void> => {
    mocks.store.set(account, value);
  },
  keychainGet: async (account: string): Promise<string | null> => {
    return mocks.store.has(account) ? (mocks.store.get(account) as string) : null;
  },
  keychainDelete: async (account: string): Promise<void> => {
    mocks.store.delete(account);
  },
}));

import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createRefreshFetch } from '../src/refresh-fetch.js';
import { KeychainOAuthProvider, tokensAccount } from '../src/oauth-provider.js';
import type { TokenEvent } from '../src/oauth-provider.js';

const TOKEN_URL = 'https://auth.example/token';
const ACCOUNT = tokensAccount('notion');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function refreshInit(rt: string): RequestInit {
  // Mirror of the SDK's executeTokenRequest POST shape; test (e) pins the real
  // SDK to this same shape so drift breaks loudly there.
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
  };
}

function makeProvider(): { provider: KeychainOAuthProvider; events: TokenEvent[] } {
  const events: TokenEvent[] = [];
  const provider = new KeychainOAuthProvider('notion', (e) => events.push(e));
  return { provider, events };
}

const tmpDirs: string[] = [];
function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-refresh-fetch-'));
  tmpDirs.push(dir);
  return join(dir, 'locks', 'notion.refresh.lock');
}

beforeEach(() => {
  mocks.store.clear();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createRefreshFetch', () => {
  it('(a) two processes: the second arrival never hits the network and coalesces onto the first rotation', async () => {
    const lockPath = tempLockPath();
    mocks.store.set(
      ACCOUNT,
      JSON.stringify({ access_token: 'at1', refresh_token: 'rt1', token_type: 'Bearer' }),
    );

    let networkCalls = 0;
    // "Process A": its refresh round trip is slow enough for B to queue on the lock.
    const baseFetchA: FetchLike = async () => {
      networkCalls++;
      await sleep(80);
      return jsonResponse({ access_token: 'at2', refresh_token: 'rt2', token_type: 'Bearer' });
    };
    // "Process B": if this ever runs, single-flight failed.
    const baseFetchB: FetchLike = async () => {
      networkCalls++;
      return jsonResponse({ access_token: 'never', refresh_token: 'never', token_type: 'Bearer' });
    };

    const a = makeProvider();
    const b = makeProvider();
    const fetchA = createRefreshFetch({
      mcp: 'notion', lockPath, provider: a.provider, baseFetch: baseFetchA,
      lockOptions: { pollMs: 10 },
    });
    const fetchB = createRefreshFetch({
      mcp: 'notion', lockPath, provider: b.provider, baseFetch: baseFetchB,
      lockOptions: { pollMs: 10 },
    });

    // Both refresh with the SAME (soon-to-be-stale) rt1 — the incident scenario.
    const [respA, respB] = await Promise.all([
      fetchA(TOKEN_URL, refreshInit('rt1')),
      (async () => {
        await sleep(20); // let A win the lock first
        return fetchB(TOKEN_URL, refreshInit('rt1'));
      })(),
    ]);

    expect(networkCalls).toBe(1); // only A went to the network
    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);
    const tokensB = (await respB.json()) as { access_token: string; refresh_token: string };
    // B received A's rotation, served from the Keychain.
    expect(tokensB.access_token).toBe('at2');
    expect(tokensB.refresh_token).toBe('rt2');
    expect(b.events).toContainEqual({ event: 'refresh_coalesced' });
    // A persisted INSIDE the critical section: the Keychain holds rt2.
    const stored = JSON.parse(mocks.store.get(ACCOUNT) as string) as { refresh_token: string };
    expect(stored.refresh_token).toBe('rt2');
    // The lock is released.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('(c) lock timeout: fail-open with a lock_timeout event and the refresh proceeds', async () => {
    const lockPath = tempLockPath();
    // A held lock owned by a live PID (ourselves), young mtime: unreclaimable.
    const { acquireRefreshLock } = await import('../src/refresh-lock.js');
    const held = await acquireRefreshLock(lockPath, { pollMs: 5, timeoutMs: 200 });
    expect(held.acquired).toBe(true);

    let networkCalls = 0;
    const baseFetch: FetchLike = async () => {
      networkCalls++;
      return jsonResponse({ access_token: 'at2', refresh_token: 'rt2', token_type: 'Bearer' });
    };
    const { provider, events } = makeProvider();
    const refreshFetch = createRefreshFetch({
      mcp: 'notion', lockPath, provider, baseFetch,
      lockOptions: { pollMs: 10, timeoutMs: 50 },
    });

    const resp = await refreshFetch(TOKEN_URL, refreshInit('rt1'));
    expect(resp.status).toBe(200);
    expect(networkCalls).toBe(1); // the refresh proceeded (unlocked)
    const timeout = events.find((e) => e.event === 'lock_timeout');
    expect(timeout).toBeDefined();
    if (timeout?.event === 'lock_timeout') expect(timeout.waitedMs).toBeGreaterThanOrEqual(50);

    if (held.acquired) await held.release();
  });

  it('(d) passthrough: non-refresh requests never touch the lock', async () => {
    const lockPath = tempLockPath();
    const lockDir = join(lockPath, '..');

    let networkCalls = 0;
    const baseFetch: FetchLike = async () => {
      networkCalls++;
      return jsonResponse({ ok: true });
    };
    const { provider, events } = makeProvider();
    const refreshFetch = createRefreshFetch({ mcp: 'notion', lockPath, provider, baseFetch });

    // A normal MCP POST (JSON string body, like the transport's send()).
    await refreshFetch('https://mcp.example/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    // A token request that is NOT a refresh (authorization_code exchange).
    await refreshFetch(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });
    // A GET (SSE stream open).
    await refreshFetch('https://mcp.example/mcp', { method: 'GET' });

    expect(networkCalls).toBe(3);
    expect(events).toEqual([]); // no single-flight activity
    // acquireRefreshLock was never called: the locks dir was never even created.
    expect(existsSync(lockDir)).toBe(false);
  });

  it('(e) anti-drift: the vendored SDK refresh request has the shape the interceptor detects', async () => {
    // Layer 1 — pin the raw shape: URLSearchParams body with grant_type=refresh_token.
    let captured: { url: string | URL; init?: RequestInit } | undefined;
    const capture: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ access_token: 'at', token_type: 'Bearer' });
    };
    await refreshAuthorization('https://auth.example', {
      clientInformation: { client_id: 'cid' },
      refreshToken: 'rt-drift',
      fetchFn: capture,
    });
    const body = captured?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('grant_type')).toBe('refresh_token');
    expect((body as URLSearchParams).get('refresh_token')).toBe('rt-drift');

    // Layer 2 — end to end: drive the REAL SDK function through the interceptor
    // and prove the interceptor recognizes its request (coalesces on mismatch).
    // If an SDK upgrade changes the request shape, the interceptor degrades to
    // passthrough and this assertion fails.
    const lockPath = tempLockPath();
    mocks.store.set(
      ACCOUNT,
      JSON.stringify({ access_token: 'atN', refresh_token: 'rtN', token_type: 'Bearer' }),
    );
    let networkCalls = 0;
    const neverNetwork: FetchLike = async () => {
      networkCalls++;
      return jsonResponse({ access_token: 'never', token_type: 'Bearer' });
    };
    const { provider, events } = makeProvider();
    const refreshFetch = createRefreshFetch({
      mcp: 'notion', lockPath, provider, baseFetch: neverNetwork,
    });

    const tokens = await refreshAuthorization('https://auth.example', {
      clientInformation: { client_id: 'cid' },
      refreshToken: 'rt-stale',
      fetchFn: refreshFetch,
    });
    expect(networkCalls).toBe(0);
    expect(events).toContainEqual({ event: 'refresh_coalesced' });
    expect(tokens.access_token).toBe('atN');
    expect(tokens.refresh_token).toBe('rtN');
  });

  it('(f) mismatch: synthesized 200 with the stored tokens, and the follow-up saveTokens is idempotent', async () => {
    const lockPath = tempLockPath();
    const { provider, events } = makeProvider();

    // The provider cached rt1 (what this process will try to refresh with)...
    mocks.store.set(
      ACCOUNT,
      JSON.stringify({ access_token: 'at1', refresh_token: 'rt1', token_type: 'Bearer' }),
    );
    await provider.tokens();
    // ...and meanwhile ANOTHER process rotated the Keychain to rt2.
    const rotated = { access_token: 'at2', refresh_token: 'rt2', token_type: 'Bearer' };
    mocks.store.set(ACCOUNT, JSON.stringify(rotated));

    let networkCalls = 0;
    const baseFetch: FetchLike = async () => {
      networkCalls++;
      return jsonResponse({ access_token: 'never', token_type: 'Bearer' });
    };
    const refreshFetch = createRefreshFetch({ mcp: 'notion', lockPath, provider, baseFetch });

    const resp = await refreshFetch(TOKEN_URL, refreshInit('rt1'));
    expect(networkCalls).toBe(0);
    expect(resp.status).toBe(200);
    const synthesized = (await resp.json()) as typeof rotated;
    expect(synthesized).toEqual(rotated);
    expect(events).toContainEqual({ event: 'refresh_coalesced' });

    // What the SDK does next: saveTokens with the synthesized payload. The
    // Keychain value must be byte-identical afterwards (idempotent re-write);
    // the provider's own rotation detection still fires off its stale cache.
    await provider.saveTokens(synthesized);
    expect(mocks.store.get(ACCOUNT)).toBe(JSON.stringify(rotated));
    expect(events).toContainEqual({ event: 'refreshed', rotated: true });
    expect(await provider.tokens()).toEqual(rotated);
  });
});
