// proxy.oauth_authorized end to end: runLogin with the REAL LoginOAuthProvider (the
// Keychain is an in-memory Map, `open` is a no-op), the real recorder writing
// to a temp data folder through EventSink + JsonlWriter. Assertions are on the
// bytes written — the trail file and the reference file — not on objects.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const mocks = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../src/keychain.js', () => ({
  keychainSet: vi.fn(async (account: string, value: string) => {
    mocks.store.set(account, value);
  }),
  keychainGet: vi.fn(async (account: string) => (mocks.store.has(account) ? (mocks.store.get(account) as string) : null)),
  keychainDelete: vi.fn(async (account: string) => {
    mocks.store.delete(account);
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: () => {} })),
}));

import { runLogin } from '../src/login.js';
import type { LoginOAuthProvider } from '../src/oauth-provider.js';
import {
  normalizeAuthorizationServer,
  normalizeScopes,
  oauthReferencePath,
  recordOAuthAuthorizedToDisk,
} from '../src/oauth-authorized.js';

const SENTINEL = 'XCG_DO_NOT_STORE_12345';
const NAME = 'acme';
const MCP_URL = 'https://mcp.acme.example/mcp';
const AS = 'https://auth.acme.example/';

let baseDir: string;
let errSpy: { mockRestore: () => void };

beforeEach(() => {
  mocks.store.clear();
  baseDir = mkdtempSync(join(tmpdir(), 'xcg-oauth-authorized-'));
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  errSpy.mockRestore();
  rmSync(baseDir, { recursive: true, force: true });
});

interface Scenario {
  authorizationServer?: string;
  /** false: the PRM names no authorization server (SDK fallback). */
  fromPrm?: boolean;
  requestedScope?: string | null;
  resource?: string | null;
  /** Token response scope; null = the response carries none. */
  grantedScope?: string | null;
  /** 'redirect' (code exchange) | 'refresh' (AUTHORIZED, tokens saved, no redirect). */
  outcome?: 'redirect' | 'refresh';
  failAt?: 'callback' | 'exchange';
  /** true: take the no-scope 401 path (transport.send), not auth-first. */
  probe?: boolean;
}

/** One login through runLogin, every secret-bearing value set to the sentinel. */
async function login(s: Scenario = {}): Promise<void> {
  const as = s.authorizationServer ?? AS;
  const outcome = s.outcome ?? 'redirect';
  let provider!: LoginOAuthProvider;

  // What the SDK does inside auth(): register, discover, PKCE, redirect.
  const sdkAuth = async (p: LoginOAuthProvider): Promise<'AUTHORIZED' | 'REDIRECT'> => {
    await p.saveClientInformation({ client_id: SENTINEL, client_secret: SENTINEL, redirect_uris: [p.redirectUrl] });
    p.saveDiscoveryState({
      authorizationServerUrl: as,
      resourceMetadataUrl: `${MCP_URL}/.well-known?x=${SENTINEL}`,
      resourceMetadata: {
        resource: MCP_URL,
        ...(s.fromPrm === false ? {} : { authorization_servers: [as] }),
        scopes_supported: [SENTINEL],
        resource_documentation: `https://docs.example/${SENTINEL}`,
      },
      authorizationServerMetadata: {
        issuer: `https://issuer.example/${SENTINEL}`,
        authorization_endpoint: `${as}authorize`,
        token_endpoint: `${as}token?k=${SENTINEL}`,
        response_types_supported: ['code'],
      },
    });
    if (outcome === 'refresh') {
      await p.saveTokens({ access_token: SENTINEL, refresh_token: SENTINEL, token_type: 'bearer', scope: 'read' });
      return 'AUTHORIZED';
    }
    await p.saveCodeVerifier(SENTINEL);
    const u = new URL(`${as}authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', SENTINEL);
    u.searchParams.set('code_challenge', SENTINEL);
    u.searchParams.set('state', SENTINEL);
    u.searchParams.set('redirect_uri', `http://127.0.0.1:51703/xcg-callback?cb=${SENTINEL}`);
    const scope = s.requestedScope === undefined ? 'read write' : s.requestedScope;
    if (scope !== null) u.searchParams.set('scope', scope);
    const resource = s.resource === undefined ? MCP_URL : s.resource;
    if (resource !== null) u.searchParams.set('resource', resource);
    p.redirectToAuthorization(u);
    return 'REDIRECT';
  };

  const transport = {
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async () => {
      if (!s.probe) return;
      if ((await sdkAuth(provider)) === 'REDIRECT') throw new UnauthorizedError('redirect');
    }),
    finishAuth: vi.fn(async (code: string) => {
      expect(code).toBe(`code-${SENTINEL}`);
      if (s.failAt === 'exchange') throw new Error('token endpoint said no');
      const granted = s.grantedScope === undefined ? 'read write' : s.grantedScope;
      await provider.saveTokens({
        access_token: SENTINEL,
        refresh_token: SENTINEL,
        token_type: 'bearer',
        ...(granted === null ? {} : { scope: granted }),
      });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const callback = {
    waitForCode: vi.fn(async () => {
      if (s.failAt === 'callback') throw new Error('authorization callback error: access_denied');
      return `code-${SENTINEL}`;
    }),
    close: vi.fn(),
  };

  await runLogin(
    { url: MCP_URL, name: NAME, ...(s.probe ? {} : { scope: 'read write' }) },
    {
      authFn: (p) => sdkAuth(p as LoginOAuthProvider),
      discoverFn: vi.fn().mockResolvedValue({}),
      hasStored: vi.fn().mockResolvedValue(false),
      createTransport: (_url, p) => {
        provider = p;
        return transport;
      },
      startCallback: () => Promise.resolve(callback),
      recordAuthorization: (name, capture) => recordOAuthAuthorizedToDisk(name, capture, baseDir),
    },
  );
}

/** Every trail line written so far, in order, and every byte on disk. */
function onDisk(): { lines: Record<string, unknown>[]; bytes: Buffer } {
  const chunks: Buffer[] = [];
  const lines: Record<string, unknown>[] = [];
  const wrappers = join(baseDir, 'wrappers');
  const files = existsSync(wrappers) ? readdirSync(wrappers).filter((f) => f.endsWith('.jsonl')).sort() : [];
  for (const f of files) {
    const b = readFileSync(join(wrappers, f));
    chunks.push(b);
    for (const l of b.toString('utf8').split('\n')) if (l.length > 0) lines.push(JSON.parse(l) as Record<string, unknown>);
  }
  const ref = oauthReferencePath(baseDir, NAME);
  if (existsSync(ref)) chunks.push(readFileSync(ref));
  return { lines, bytes: Buffer.concat(chunks) };
}

const authorized = (lines: Record<string, unknown>[]) => lines.filter((l) => l['type'] === 'proxy.oauth_authorized');
const referenceEvents = (lines: Record<string, unknown>[]) => lines.filter((l) => l['type'] === 'proxy.oauth_reference');

describe('proxy.oauth_authorized — what reaches the disk', () => {
  it('the sentinel in tokens, code, state, verifier, client_id, callback and metadata never does', async () => {
    await login();
    const { lines, bytes } = onDisk();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.includes(SENTINEL)).toBe(false);
    expect(authorized(lines)).toHaveLength(1);
    expect(authorized(lines)[0]).toMatchObject({
      mcp: NAME,
      authorization_server: AS,
      authorization_server_source: 'protected_resource_metadata',
      resource: MCP_URL,
      requested_scopes: ['read', 'write'],
      effective_granted_scopes: ['read', 'write'],
      scope_source: 'token_response',
      first_login: true,
      changes: [],
      findings: [],
    });
    const ref = JSON.parse(readFileSync(oauthReferencePath(baseDir, NAME), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(ref).sort()).toEqual(
      ['authorization_server', 'effective_granted_scopes', 'generation', 'mcp', 'resource', 'storage_version', 'updated_at'],
    );
  });

  it('the sentinel in the authorization server\'s userinfo, credential query value and fragment never does', async () => {
    await login({ authorizationServer: `https://${SENTINEL}:${SENTINEL}@auth.acme.example/?token=${SENTINEL}#${SENTINEL}` });
    const { lines, bytes } = onDisk();
    expect(bytes.includes(SENTINEL)).toBe(false);
    const stored = authorized(lines)[0]!['authorization_server'] as string;
    expect(stored.startsWith('https://auth.acme.example/?token=')).toBe(true);
    expect(stored).not.toContain('#');
    expect(stored).not.toContain('@');
  });

  it('the authorization server is compared normalized: its query and fragment are not a change', async () => {
    await login({ authorizationServer: `https://auth.acme.example/?token=${SENTINEL}#${SENTINEL}` });
    await login({ authorizationServer: 'https://auth.acme.example/' });
    expect(authorized(onDisk().lines)[1]).toMatchObject({ findings: [], changes: [] });
  });

  it('the 401 path (no explicit scope) records the same way', async () => {
    await login({ probe: true });
    const { lines, bytes } = onDisk();
    expect(bytes.includes(SENTINEL)).toBe(false);
    expect(authorized(lines)).toHaveLength(1);
  });

  it('no scope in the token response: the requested ones, marked assumed_requested', async () => {
    await login({ grantedScope: null });
    expect(authorized(onDisk().lines)[0]).toMatchObject({
      effective_granted_scopes: ['read', 'write'],
      scope_source: 'assumed_requested',
    });
  });

  it('no authorization_servers in the PRM: the SDK fallback, marked server_url_fallback', async () => {
    await login({ fromPrm: false });
    expect(authorized(onDisk().lines)[0]).toMatchObject({ authorization_server_source: 'server_url_fallback' });
  });

  it('no resource parameter: resource null', async () => {
    await login({ resource: null });
    expect(authorized(onDisk().lines)[0]).toMatchObject({ resource: null });
  });
});

describe('proxy.oauth_authorized — only when a code was exchanged', () => {
  it('a refresh (AUTHORIZED, tokens saved, no redirect): no event, no reference', async () => {
    await login({ outcome: 'refresh' });
    expect(onDisk().lines).toHaveLength(0);
    expect(existsSync(oauthReferencePath(baseDir, NAME))).toBe(false);
  });

  it('a failed callback: login fails, no event, reference untouched', async () => {
    await login();
    const before = readFileSync(oauthReferencePath(baseDir, NAME));
    const linesBefore = onDisk().lines.length;
    await expect(login({ authorizationServer: 'https://evil.example/', failAt: 'callback' })).rejects.toThrow(/access_denied/);
    expect(onDisk().lines).toHaveLength(linesBefore);
    expect(readFileSync(oauthReferencePath(baseDir, NAME))).toEqual(before);
  });

  it('a failed code exchange: login fails, no event, no reference', async () => {
    await expect(login({ failAt: 'exchange' })).rejects.toThrow(/token endpoint/);
    expect(onDisk().lines).toHaveLength(0);
    expect(existsSync(oauthReferencePath(baseDir, NAME))).toBe(false);
  });
});

describe('proxy.oauth_authorized — comparison with the last good login', () => {
  it('first login: reference initialized (visible), recorded, no findings', async () => {
    await login();
    const { lines } = onDisk();
    expect(referenceEvents(lines)).toEqual([expect.objectContaining({ event: 'initialized', reason: 'missing' })]);
    expect(authorized(lines)[0]).toMatchObject({ first_login: true, findings: [], changes: [] });
  });

  it('no change: no findings, no changes, no reference event', async () => {
    await login();
    await login();
    const { lines } = onDisk();
    expect(referenceEvents(lines)).toHaveLength(1);
    expect(authorized(lines)[1]).toMatchObject({ first_login: false, findings: [], changes: [] });
  });

  it('a different authorization server: authorization_server_changed, high', async () => {
    await login();
    await login({ authorizationServer: 'https://login.other.example/' });
    expect(authorized(onDisk().lines)[1]!['findings']).toEqual([
      {
        rule_id: 'authorization_server_changed',
        rule_version: 1,
        severity: 'high',
        before: AS,
        after: 'https://login.other.example/',
      },
    ]);
  });

  it('scopes expanded: scopes_expanded, medium, with only the added ones', async () => {
    await login({ grantedScope: 'read write' });
    await login({ grantedScope: 'write admin read delete' });
    expect(authorized(onDisk().lines)[1]!['findings']).toEqual([
      { rule_id: 'scopes_expanded', rule_version: 1, severity: 'medium', added: ['admin', 'delete'] },
    ]);
  });

  it('scopes reduced: the fact only, no finding', async () => {
    await login({ grantedScope: 'read write' });
    await login({ grantedScope: 'read' });
    expect(authorized(onDisk().lines)[1]).toMatchObject({
      findings: [],
      changes: [{ field: 'scopes_reduced', removed: ['write'] }],
    });
  });

  it('resource changed: the fact only, no finding', async () => {
    await login();
    await login({ resource: 'https://mcp.acme.example/v2' });
    expect(authorized(onDisk().lines)[1]).toMatchObject({
      findings: [],
      changes: [{ field: 'resource', before: MCP_URL, after: 'https://mcp.acme.example/v2' }],
    });
  });

  it('normalization: scheme/host case, trailing slash and scope order are not changes', async () => {
    await login({ authorizationServer: 'https://auth.acme.example/tenant/', grantedScope: 'write read' });
    await login({ authorizationServer: 'HTTPS://Auth.ACME.example/tenant', grantedScope: 'read  write read' });
    const second = authorized(onDisk().lines)[1]!;
    expect(second['findings']).toEqual([]);
    expect(second['changes']).toEqual([]);
    // Stored canonical (scheme and host lowercase), compared normalized too.
    expect(second['authorization_server']).toBe('https://auth.acme.example/tenant');
  });

  it('the reference is rewritten even when there is a finding: the same change is reported once', async () => {
    await login();
    await login({ authorizationServer: 'https://login.other.example/' });
    await login({ authorizationServer: 'https://login.other.example/' });
    const events = authorized(onDisk().lines);
    expect(events[1]!['findings']).toHaveLength(1);
    expect(events[2]!['findings']).toEqual([]);
    const ref = JSON.parse(readFileSync(oauthReferencePath(baseDir, NAME), 'utf8')) as Record<string, unknown>;
    expect(ref['generation']).toBe(3);
  });

  it('a corrupt reference: reseeded (visible, not high), the login counts as the first one', async () => {
    await login();
    writeFileSync(oauthReferencePath(baseDir, NAME), '{ not json');
    await login({ authorizationServer: 'https://login.other.example/' });
    const { lines } = onDisk();
    expect(referenceEvents(lines).map((e) => [e['event'], e['reason']])).toEqual([
      ['initialized', 'missing'],
      ['reseeded', 'corrupt'],
    ]);
    expect(authorized(lines)[1]).toMatchObject({ first_login: true, findings: [] });
    const ref = JSON.parse(readFileSync(oauthReferencePath(baseDir, NAME), 'utf8')) as Record<string, unknown>;
    expect(ref['authorization_server']).toBe('https://login.other.example/');
    expect(ref['generation']).toBe(1);
  });
});

describe('normalizers', () => {
  it('normalizeAuthorizationServer: lowercase scheme and host, no trailing slash, no query', () => {
    expect(normalizeAuthorizationServer('HTTPS://Auth.Example.COM/')).toBe('https://auth.example.com');
    expect(normalizeAuthorizationServer('https://auth.example.com/tenant/v2/')).toBe('https://auth.example.com/tenant/v2');
    expect(normalizeAuthorizationServer('https://auth.example.com:8443/x?y=1')).toBe('https://auth.example.com:8443/x');
    expect(normalizeAuthorizationServer(' Not A URL/ ')).toBe('not a url');
  });

  it('normalizeScopes: split, dedupe, sort', () => {
    expect(normalizeScopes('b  a b')).toEqual(['a', 'b']);
    expect(normalizeScopes(['c a', 'a'])).toEqual(['a', 'c']);
    expect(normalizeScopes(null)).toEqual([]);
  });
});
