// The 08/10 stripe incident, end to end through the SDK's real auth(): a
// Reconnect's login waits for the browser while Claude Desktop starts the
// connector's wrapper again and again with no token. Before the fix each
// wrapper ran auth() to the end — discovery, PKCE, saveCodeVerifier into the
// shared Keychain item — and the login's exchange then failed with "Invalid
// code_verifier". The Keychain is an in-memory Map that logs every write; the
// authorization server is a fake that really checks PKCE and refresh tokens.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  writes: [] as Array<{ op: 'set' | 'delete'; account: string }>,
  opened: [] as string[],
}));

vi.mock('../src/keychain.js', () => ({
  keychainSet: async (account: string, value: string): Promise<void> => {
    mocks.writes.push({ op: 'set', account });
    mocks.store.set(account, value);
  },
  keychainGet: async (account: string): Promise<string | null> =>
    mocks.store.has(account) ? (mocks.store.get(account) as string) : null,
  keychainDelete: async (account: string): Promise<void> => {
    mocks.writes.push({ op: 'delete', account });
    mocks.store.delete(account);
  },
}));

// LoginOAuthProvider.redirectToAuthorization "opens the browser": record the URL.
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: readonly string[]) => {
    mocks.opened.push(args[0] as string);
    return { unref: (): void => undefined };
  },
}));

import { KeychainOAuthProvider, LoginOAuthProvider, ReauthRequiredError } from '../src/oauth-provider.js';
import { createRefreshFetch } from '../src/refresh-fetch.js';
import { CALLBACK_COMPLETE_HTML, CALLBACK_FAILED_HTML, runLogin, startCallbackListener } from '../src/login.js';

const NAME = 'acme';
const MCP_URL = 'https://mcp.acme.example/mcp';
const AS = 'https://auth.acme.example/';
const HOUR_MS = 3_600_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** A fake MCP resource + authorization server. Every request is logged with
 *  the caller's label, so a test can say who touched the network. */
function fakeAuthServer() {
  const calls: Array<{ who: string; path: string }> = [];
  const registrations: string[] = [];
  const codes = new Map<string, { clientId: string; challenge: string }>();
  const refreshTokens = new Map<string, string>(); // rt → client_id
  const revokedClients = new Set<string>();
  let n = 0;

  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    if (url.origin === new URL(MCP_URL).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json({ resource: MCP_URL, authorization_servers: [AS] });
    }
    if (url.origin !== new URL(AS).origin) return new Response('', { status: 404 });
    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}authorize`,
          token_endpoint: `${AS}token`,
          registration_endpoint: `${AS}register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      case '/register': {
        const clientId = `cid-${++n}`;
        registrations.push(clientId);
        const meta = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ ...meta, client_id: clientId }, 201);
      }
      case '/token': {
        const body = new URLSearchParams(String(init?.body));
        const clientId = body.get('client_id') ?? '';
        if (revokedClients.has(clientId)) return json({ error: 'invalid_client' }, 401);
        if (body.get('grant_type') === 'authorization_code') {
          const issued = codes.get(body.get('code') ?? '');
          if (issued === undefined || issued.clientId !== clientId) return json({ error: 'invalid_grant' }, 400);
          if (s256(body.get('code_verifier') ?? '') !== issued.challenge) {
            return json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' }, 400);
          }
          codes.delete(body.get('code') ?? '');
        } else if (body.get('grant_type') === 'refresh_token') {
          const rt = body.get('refresh_token') ?? '';
          if (refreshTokens.get(rt) !== clientId) return json({ error: 'invalid_grant' }, 400);
          refreshTokens.delete(rt);
        } else {
          return json({ error: 'unsupported_grant_type' }, 400);
        }
        const k = ++n;
        refreshTokens.set(`rt-${k}`, clientId);
        return json({ access_token: `at-${k}`, refresh_token: `rt-${k}`, token_type: 'Bearer', expires_in: 3600 });
      }
      default:
        return new Response('', { status: 404 });
    }
  };

  return {
    calls,
    registrations,
    refreshTokens,
    revokedClients,
    fetchFor(who: string): FetchLike {
      return async (input, init) => {
        const url = new URL(String(input));
        calls.push({ who, path: url.pathname });
        return handle(url, init);
      };
    },
    /** The user approves in the browser: the server binds a code to the
     *  authorization URL's client and PKCE challenge. */
    approve(authorizationUrl: string): string {
      const u = new URL(authorizationUrl);
      const code = `code-${++n}`;
      codes.set(code, { clientId: u.searchParams.get('client_id') ?? '', challenge: u.searchParams.get('code_challenge') ?? '' });
      return code;
    },
  };
}

function seedClient(clientId: string): void {
  mocks.store.set(`${NAME}:client`, JSON.stringify({ client_id: clientId, redirect_uris: ['http://127.0.0.1:51703/xcg-callback'] }));
}

function seedTokens(t: Record<string, unknown>): void {
  mocks.store.set(`${NAME}:tokens`, JSON.stringify({ token_type: 'Bearer', issuer: AS, ...t }));
}

const stored = (kind: 'tokens' | 'client' | 'verifier'): string | undefined => mocks.store.get(`${NAME}:${kind}`);
const writesTo = (kind: 'client' | 'verifier') => mocks.writes.filter((w) => w.account === `${NAME}:${kind}`);

let errSpy: { mockRestore: () => void };

beforeEach(() => {
  mocks.store.clear();
  mocks.writes.length = 0;
  mocks.opened.length = 0;
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  errSpy.mockRestore();
});

/** Five wrappers starting with no token while the login waits. */
async function fiveWrappersWithoutToken(as: ReturnType<typeof fakeAuthServer>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const wrapper = new KeychainOAuthProvider(NAME);
    await expect(auth(wrapper, { serverUrl: MCP_URL, fetchFn: as.fetchFor('wrapper') })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  }
}

describe('Reconnect with Claude Desktop open: wrappers no longer break a login in progress', () => {
  it('no prior client: 5 wrappers start without a token during the authorization → the login completes, only the login registers', async () => {
    const as = fakeAuthServer();
    const login = new LoginOAuthProvider(NAME);

    expect(await auth(login, { serverUrl: MCP_URL, fetchFn: as.fetchFor('login') })).toBe('REDIRECT');
    expect(mocks.opened).toHaveLength(1);
    const code = as.approve(mocks.opened[0]!);

    await fiveWrappersWithoutToken(as);
    // The wrappers stopped before discovery: no network, no Keychain write.
    expect(as.calls.filter((c) => c.who === 'wrapper')).toEqual([]);
    expect(mocks.writes).toEqual([]);

    expect(await auth(login, { serverUrl: MCP_URL, authorizationCode: code, fetchFn: as.fetchFor('login') })).toBe(
      'AUTHORIZED',
    );
    // Nothing written until the login persists what the exchange produced.
    expect(mocks.writes).toEqual([]);
    await login.persistAuthorization();

    expect(as.registrations).toEqual(['cid-1']);
    expect(JSON.parse(stored('client')!)).toMatchObject({ client_id: 'cid-1' });
    expect(JSON.parse(stored('tokens')!)).toMatchObject({ access_token: expect.stringMatching(/^at-/) });
    expect(stored('verifier')).toBeUndefined();
    expect(writesTo('verifier')).toEqual([]);
  });

  it('prior client (e.g. a seeded BYO client): same race → the login completes and nobody registers', async () => {
    const as = fakeAuthServer();
    seedClient('byo-client');
    const login = new LoginOAuthProvider(NAME);

    expect(await auth(login, { serverUrl: MCP_URL, fetchFn: as.fetchFor('login') })).toBe('REDIRECT');
    const code = as.approve(mocks.opened[0]!);
    await fiveWrappersWithoutToken(as);
    expect(writesTo('client')).toEqual([]);

    expect(await auth(login, { serverUrl: MCP_URL, authorizationCode: code, fetchFn: as.fetchFor('login') })).toBe(
      'AUTHORIZED',
    );
    await login.persistAuthorization();

    expect(as.registrations).toEqual([]);
    expect(JSON.parse(stored('client')!)).toMatchObject({ client_id: 'byo-client' });
    expect(JSON.parse(stored('tokens')!)).toMatchObject({ access_token: expect.stringMatching(/^at-/) });
  });

  it('a wrapper deleting the stored client mid-login cannot pull it from under the exchange', async () => {
    const as = fakeAuthServer();
    seedClient('byo-client');
    const login = new LoginOAuthProvider(NAME);
    expect(await auth(login, { serverUrl: MCP_URL, fetchFn: as.fetchFor('login') })).toBe('REDIRECT');
    const code = as.approve(mocks.opened[0]!);

    mocks.store.delete(`${NAME}:client`);

    expect(await auth(login, { serverUrl: MCP_URL, authorizationCode: code, fetchFn: as.fetchFor('login') })).toBe(
      'AUTHORIZED',
    );
  });

  it('after a successful login a new wrapper uses the persisted client and tokens, and refreshes with them', async () => {
    const as = fakeAuthServer();
    const login = new LoginOAuthProvider(NAME);
    await auth(login, { serverUrl: MCP_URL, fetchFn: as.fetchFor('login') });
    const code = as.approve(mocks.opened[0]!);
    await auth(login, { serverUrl: MCP_URL, authorizationCode: code, fetchFn: as.fetchFor('login') });
    await login.persistAuthorization();
    const issued = JSON.parse(stored('tokens')!) as { access_token: string };

    const wrapper = new KeychainOAuthProvider(NAME);
    expect((await wrapper.tokens())?.access_token).toBe(issued.access_token);
    await expect(wrapper.discoveryState()).resolves.toBeUndefined();

    // Its access token expires: the wrapper refreshes with the login's client.
    const blob = JSON.parse(stored('tokens')!) as Record<string, unknown>;
    seedTokens({ ...blob, obtained_at: Date.now() - 2 * HOUR_MS });
    const later = new KeychainOAuthProvider(NAME);
    expect(await auth(later, { serverUrl: MCP_URL, fetchFn: as.fetchFor('wrapper') })).toBe('AUTHORIZED');
    expect(JSON.parse(stored('tokens')!)).not.toMatchObject({ access_token: issued.access_token });
  });
});

// Invariant: the wrapper never creates or overwrites :client; it only deletes
// it if the server rejects it (invalid_client / unauthorized_client). It never
// touches :verifier.
describe('the wrapper never creates or overwrites :client, and never touches :verifier', () => {
  it('without a token: ReauthRequiredError, no network, no Keychain write at all', async () => {
    const as = fakeAuthServer();
    const wrapper = new KeychainOAuthProvider(NAME);
    await expect(auth(wrapper, { serverUrl: MCP_URL, fetchFn: as.fetchFor('wrapper') })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect(as.calls).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it.each([
    ['a valid access token and no refresh token (server answered 401)', 'valid-no-rt'],
    ['an expired access token and a valid refresh token', 'refresh-ok'],
    ['an expired access token and a revoked refresh token', 'refresh-rejected'],
    ['no stored client', 'no-client'],
  ] as const)('with %s', async (_label, scenario) => {
    const as = fakeAuthServer();
    // A :verifier left by an earlier version, and an unbound client.
    mocks.store.set(`${NAME}:verifier`, 'legacy');
    if (scenario !== 'no-client') seedClient('cid-0');
    if (scenario === 'valid-no-rt') seedTokens({ access_token: 'at-0', expires_in: 3600, obtained_at: Date.now() });
    if (scenario === 'refresh-ok' || scenario === 'no-client') as.refreshTokens.set('rt-0', 'cid-0');
    if (scenario !== 'valid-no-rt') {
      seedTokens({ access_token: 'at-0', refresh_token: 'rt-0', expires_in: 3600, obtained_at: Date.now() - 2 * HOUR_MS });
    }
    const clientBefore = stored('client');

    const wrapper = new KeychainOAuthProvider(NAME);
    const run = auth(wrapper, { serverUrl: MCP_URL, fetchFn: as.fetchFor('wrapper') });
    if (scenario === 'refresh-ok') await expect(run).resolves.toBe('AUTHORIZED');
    else await expect(run).rejects.toBeInstanceOf(ReauthRequiredError);

    expect(writesTo('verifier')).toEqual([]);
    expect(writesTo('client')).toEqual([]);
    expect(stored('verifier')).toBe('legacy');
    expect(stored('client')).toBe(clientBefore);
    expect(as.registrations).toEqual([]);
  });

  it('the one exception: the server rejects the client (invalid_client) → :client deleted, :verifier untouched, re-login', async () => {
    const as = fakeAuthServer();
    mocks.store.set(`${NAME}:verifier`, 'legacy');
    seedClient('cid-0');
    as.refreshTokens.set('rt-0', 'cid-0');
    as.revokedClients.add('cid-0');
    seedTokens({ access_token: 'at-0', refresh_token: 'rt-0', expires_in: 3600, obtained_at: Date.now() - 2 * HOUR_MS });

    const wrapper = new KeychainOAuthProvider(NAME);
    await expect(auth(wrapper, { serverUrl: MCP_URL, fetchFn: as.fetchFor('wrapper') })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect(writesTo('client')).toEqual([{ op: 'delete', account: `${NAME}:client` }]);
    expect(stored('client')).toBeUndefined();
    expect(writesTo('verifier')).toEqual([]);
    expect(as.registrations).toEqual([]);
  });

  it('regression: an expired token still refreshes through the cross-process lock interceptor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xcg-reconnect-race-'));
    try {
      const as = fakeAuthServer();
      seedClient('cid-0');
      as.refreshTokens.set('rt-0', 'cid-0');
      seedTokens({ access_token: 'at-0', refresh_token: 'rt-0', expires_in: 3600, obtained_at: Date.now() - 2 * HOUR_MS });
      const wrapper = new KeychainOAuthProvider(NAME);
      const fetchFn = createRefreshFetch({
        mcp: NAME,
        lockPath: join(dir, 'refresh.lock'),
        provider: wrapper,
        baseFetch: as.fetchFor('wrapper'),
        lockOptions: { pollMs: 10 },
      });
      expect(await auth(wrapper, { serverUrl: MCP_URL, fetchFn })).toBe('AUTHORIZED');
      expect(JSON.parse(stored('tokens')!)).toMatchObject({ refresh_token: expect.not.stringMatching(/^rt-0$/) });
      expect(as.calls.filter((c) => c.path === '/token')).toHaveLength(1);
      expect(writesTo('client')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the callback page is answered after the exchange', () => {
  /** runLogin on the auth-first branch with a real loopback listener on a free
   *  port; the "browser" is a fetch to it. */
  async function loginWithBrowser(finishAuth: () => Promise<void>) {
    let listening!: (port: number) => void;
    const port = new Promise<number>((r) => (listening = r));
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn(finishAuth),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const done = runLogin(
      { url: MCP_URL, name: NAME, scope: 'read' },
      {
        authFn: vi.fn().mockResolvedValue('REDIRECT'),
        discoverFn: vi.fn().mockResolvedValue({}),
        createTransport: () => transport,
        startCallback: async () => {
          const handle = await startCallbackListener('http://127.0.0.1:0/xcg-callback', () => 'ok');
          listening(handle.port);
          return handle;
        },
        recordAuthorization: vi.fn(),
      },
    );
    const page = fetch(`http://127.0.0.1:${await port}/xcg-callback?code=abc`).then(async (r) => ({
      status: r.status,
      html: await r.text(),
    }));
    return { done, page };
  }

  it('finishAuth fails → the failed page, never the complete one', async () => {
    const { done, page } = await loginWithBrowser(() => Promise.reject(new Error('invalid_grant')));
    await expect(done).rejects.toThrow('invalid_grant');
    const shown = await page;
    expect(shown).toEqual({ status: 400, html: CALLBACK_FAILED_HTML });
    expect(shown.html).not.toContain('complete');
  });

  it('the browser waits for the exchange, then reads the complete page', async () => {
    let release!: () => void;
    const exchange = new Promise<void>((r) => (release = r));
    const { done, page } = await loginWithBrowser(() => exchange);
    let answered = false;
    void page.then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    release();
    await done;
    expect(await page).toEqual({ status: 200, html: CALLBACK_COMPLETE_HTML });
  });
});
