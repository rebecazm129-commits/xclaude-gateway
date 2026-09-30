// SEP-2352 on our side of SDK 1.31: stored OAuth sets carry `issuer` (the
// authorization server they belong to) and keep it through the Keychain, the
// cross-process refresh single-flight and the SDK's own auth().
//
// The expected issuer always comes from the discovery auth() ran in this
// process (provider.currentIssuer, fed by saveDiscoveryState) — never from the
// Keychain, never from a token response.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../src/keychain.js', () => ({
  keychainSet: async (account: string, value: string): Promise<void> => {
    mocks.store.set(account, value);
  },
  keychainGet: async (account: string): Promise<string | null> =>
    mocks.store.has(account) ? (mocks.store.get(account) as string) : null,
  keychainDelete: async (account: string): Promise<void> => {
    mocks.store.delete(account);
  },
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: () => {} })) }));

import { auth, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { KeychainOAuthProvider, LoginOAuthProvider, ReauthRequiredError, tokensAccount } from '../src/oauth-provider.js';
import type { TokenEvent } from '../src/oauth-provider.js';
import { createRefreshFetch } from '../src/refresh-fetch.js';

const MCP = 'acme';
const MCP_URL = 'https://mcp.acme.example/mcp';
const AS = 'https://as.acme.example';
const AS_OTHER = 'https://as.other.example';
const TOKEN_URL = `${AS}/token`;

const tmpDirs: string[] = [];
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-issuer-binding-'));
  tmpDirs.push(dir);
  return join(dir, 'locks', `${MCP}.refresh.lock`);
}

let errSpy: { mockRestore: () => void };
let warnSpy: { mockRestore: () => void };
beforeEach(() => {
  mocks.store.clear();
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const refreshInit = (rt: string): RequestInit => ({
  method: 'POST',
  headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
});

const storedTokens = (): Record<string, unknown> => JSON.parse(mocks.store.get(tokensAccount(MCP))!) as Record<string, unknown>;
const storedClient = (): Record<string, unknown> => JSON.parse(mocks.store.get(`${MCP}:client`)!) as Record<string, unknown>;

/** A wrapper process whose auth() run discovered `issuer`. */
function process_(issuer: string | null = AS): { provider: KeychainOAuthProvider; events: TokenEvent[] } {
  const events: TokenEvent[] = [];
  const provider = new KeychainOAuthProvider(MCP, (e) => events.push(e));
  if (issuer !== null) provider.saveDiscoveryState({ authorizationServerUrl: issuer } as OAuthDiscoveryState);
  return { provider, events };
}

describe('refresh single-flight keeps the issuer', () => {
  it('a rotated refresh keeps the issuer of the set it replaces, and drops one in the response', async () => {
    mocks.store.set(tokensAccount(MCP), JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', token_type: 'bearer', issuer: AS }));
    const { provider } = process_();
    const baseFetch = vi.fn<FetchLike>(async () =>
      json({ access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', issuer: 'https://evil.example' }),
    );
    const f = createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch });
    await f(TOKEN_URL, refreshInit('RT1'));
    expect(storedTokens()).toMatchObject({ refresh_token: 'RT2', access_token: 'AT2', issuer: AS });
    expect(mocks.store.get(tokensAccount(MCP))).not.toContain('evil.example');
  });

  it('a stale sibling set of the same server: its refresh token is spent and its issuer kept', async () => {
    mocks.store.set(
      tokensAccount(MCP),
      JSON.stringify({ access_token: 'ATs', refresh_token: 'RTs', token_type: 'bearer', expires_in: 60, obtained_at: 0, issuer: `${AS}/` }),
    );
    const { provider, events } = process_();
    const baseFetch = vi.fn<FetchLike>(async () => json({ access_token: 'AT3', refresh_token: 'RT3', token_type: 'bearer' }));
    await createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch })(TOKEN_URL, refreshInit('RT-mine'));
    const sent = (baseFetch.mock.calls[0]![1]!.body as URLSearchParams).get('refresh_token');
    expect(sent).toBe('RTs');
    expect(events.map((e) => e.event)).toContain('refresh_coalesced_stale');
    expect(storedTokens()).toMatchObject({ refresh_token: 'RT3', issuer: `${AS}/` });
  });

  it('a sibling set bound to ANOTHER server is neither coalesced onto nor spent', async () => {
    // Fresh access token: would coalesce if it were ours to use.
    mocks.store.set(tokensAccount(MCP), JSON.stringify({ access_token: 'ATx', refresh_token: 'RTx', token_type: 'bearer', issuer: AS_OTHER }));
    const { provider, events } = process_();
    const baseFetch = vi.fn<FetchLike>(async () => json({ access_token: 'AT4', refresh_token: 'RT4', token_type: 'bearer' }));
    await createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch })(TOKEN_URL, refreshInit('RT-mine'));
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect((baseFetch.mock.calls[0]![1]!.body as URLSearchParams).get('refresh_token')).toBe('RT-mine');
    expect(events.map((e) => e.event)).not.toContain('refresh_coalesced');
    // The new set belongs to the server this run discovered.
    expect(storedTokens()).toMatchObject({ refresh_token: 'RT4', issuer: AS });
  });

  it('a set written before binding (no issuer) is rewritten with the discovered one', async () => {
    mocks.store.set(tokensAccount(MCP), JSON.stringify({ access_token: 'AT0', refresh_token: 'RT0', token_type: 'bearer' }));
    const { provider } = process_();
    const baseFetch = vi.fn<FetchLike>(async () => json({ access_token: 'AT5', refresh_token: 'RT5', token_type: 'bearer' }));
    await createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch })(TOKEN_URL, refreshInit('RT0'));
    expect(storedTokens()).toMatchObject({ refresh_token: 'RT5', issuer: AS });
  });

  it('regression: two processes at once — one network refresh, the second coalesces, both on the same issuer', async () => {
    mocks.store.set(tokensAccount(MCP), JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', token_type: 'bearer', issuer: AS }));
    const lock = lockPath();
    const a = process_();
    const b = process_();
    let calls = 0;
    const baseFetch = vi.fn<FetchLike>(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return json({ access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer' });
    });
    const [ra, rb] = await Promise.all([
      createRefreshFetch({ mcp: MCP, lockPath: lock, provider: a.provider, baseFetch })(TOKEN_URL, refreshInit('RT1')),
      createRefreshFetch({ mcp: MCP, lockPath: lock, provider: b.provider, baseFetch })(TOKEN_URL, refreshInit('RT1')),
    ]);
    expect(calls).toBe(1);
    expect([...a.events, ...b.events].map((e) => e.event)).toContain('refresh_coalesced');
    const bodies = [(await ra.json()) as Record<string, unknown>, (await rb.json()) as Record<string, unknown>];
    for (const body of bodies) expect(body['refresh_token']).toBe('RT2');
    expect(storedTokens()).toMatchObject({ refresh_token: 'RT2', issuer: AS });
  });
});

// --- the real SDK auth() (1.31.0) over our provider ---------------------------

interface Net {
  fetch: FetchLike;
  calls: { url: string; grant?: string | null }[];
}

/** The MCP server names AS; AS serves metadata, registration and tokens. */
function network(tokenResponse: Record<string, unknown> = { access_token: 'ATn', refresh_token: 'RTn', token_type: 'bearer' }): Net {
  const calls: Net['calls'] = [];
  const f: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, grant: body?.get('grant_type') ?? null });
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return json({ resource: MCP_URL, authorization_servers: [AS] });
    }
    if (url.startsWith(`${AS}/.well-known/oauth-authorization-server`)) {
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: TOKEN_URL,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === `${AS}/register`) return json({ client_id: 'client-new', redirect_uris: ['http://127.0.0.1:51703/xcg-callback'] }, 201);
    if (url === TOKEN_URL) return json(tokenResponse);
    return new Response('not found', { status: 404 });
  };
  return { fetch: f, calls };
}

describe('SDK auth() with bound credentials', () => {
  function seedBoundTo(issuer: string | undefined): void {
    const stamp = issuer !== undefined ? { issuer } : {};
    mocks.store.set(`${MCP}:client`, JSON.stringify({ client_id: 'client-old', redirect_uris: ['http://127.0.0.1:51703/xcg-callback'], ...stamp }));
    mocks.store.set(
      tokensAccount(MCP),
      JSON.stringify({ access_token: 'ATo', refresh_token: 'RTo', token_type: 'bearer', expires_in: 1, obtained_at: 0, ...stamp }),
    );
  }

  it('client and tokens of ANOTHER server are treated as absent: registers again, re-authorizes, never refreshes', async () => {
    seedBoundTo(AS_OTHER);
    const net = network();
    const provider = new LoginOAuthProvider(MCP);
    const fetchFn = createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch: net.fetch });
    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).resolves.toBe('REDIRECT');
    expect(net.calls.some((c) => c.grant === 'refresh_token')).toBe(false);
    expect(net.calls.filter((c) => c.url === `${AS}/register`)).toHaveLength(1);
    expect(storedClient()).toMatchObject({ client_id: 'client-new', issuer: AS });
  });

  it('in a wrapper (no interactive login) the same state asks for re-login, again without refreshing', async () => {
    seedBoundTo(AS_OTHER);
    const net = network();
    const { provider } = process_(null);
    const fetchFn = createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch: net.fetch });
    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(net.calls.some((c) => c.grant === 'refresh_token')).toBe(false);
    // Discovery fed the expected issuer from the network, not from storage.
    expect(provider.currentIssuer()).toBe(AS);
  });

  it('tokens and client saved before binding: refreshed, then both rewritten with the issuer', async () => {
    seedBoundTo(undefined);
    const net = network({ access_token: 'ATn', refresh_token: 'RTn', token_type: 'bearer', issuer: 'https://evil.example' });
    const { provider } = process_(null);
    const fetchFn = createRefreshFetch({ mcp: MCP, lockPath: lockPath(), provider, baseFetch: net.fetch });
    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).resolves.toBe('AUTHORIZED');
    expect(net.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
    expect(storedTokens()).toMatchObject({ refresh_token: 'RTn', issuer: AS });
    expect(storedClient()).toMatchObject({ client_id: 'client-old', issuer: AS });
    expect([...mocks.store.values()].join('')).not.toContain('evil.example');
  });
});
