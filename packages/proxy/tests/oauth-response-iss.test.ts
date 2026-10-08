// Login hardening for MCP 2026-07-28:
//   RFC 8414 §3.3 — the metadata's issuer must be the URL it was discovered at
//                   (raw text; only a root URL may differ by its final slash).
//                   The login refuses; a wrapper only records it.
//   RFC 9207 / SEP-2468 — the callback's `iss` is compared EXACTLY with the
//                   metadata's issuer before the code is exchanged; repeated
//                   parameters are refused; a refusal shows nothing the server sent.
// Values are the real ones published by Google and GitHub (30/09).

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

import {
  CALLBACK_FAILED_HTML,
  escapeHtml,
  ISS_MISMATCH_MESSAGE,
  ISS_MISSING_MESSAGE,
  REPEATED_PARAMETER_MESSAGE,
  callbackOutcome,
  interpretCallback,
} from '../src/login.js';
import {
  KeychainOAuthProvider,
  LoginOAuthProvider,
  METADATA_ISSUER_MISMATCH_MESSAGE,
  metadataIssuerMatches,
  type TokenEvent,
} from '../src/oauth-provider.js';

const GOOGLE_AS = 'https://accounts.google.com/'; // as advertised in authorization_servers
const GOOGLE_ISSUER = 'https://accounts.google.com'; // as in its own metadata
const GITHUB = 'https://github.com/login/oauth';
const CALLBACK = '/xcg-callback';

let errSpy: { mockRestore: () => void };
beforeEach(() => {
  mocks.store.clear();
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  errSpy.mockRestore();
});

function state(asUrl: string, issuer: string, issSupported?: boolean): OAuthDiscoveryState {
  return {
    authorizationServerUrl: asUrl,
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'],
      ...(issSupported !== undefined ? { authorization_response_iss_parameter_supported: issSupported } : {}),
    },
  } as OAuthDiscoveryState;
}

describe('RFC 8414 §3.3 — metadataIssuerMatches', () => {
  it('Google: authorization server with the final slash, issuer without — the same (root URL)', () => {
    expect(metadataIssuerMatches(GOOGLE_ISSUER, GOOGLE_AS)).toBe(true);
    expect(metadataIssuerMatches(GOOGLE_AS, GOOGLE_ISSUER)).toBe(true);
  });

  it('identical text matches', () => {
    expect(metadataIssuerMatches(GITHUB, GITHUB)).toBe(true);
  });

  it('a non-empty path with one slash more does not', () => {
    expect(metadataIssuerMatches(`${GITHUB}/`, GITHUB)).toBe(false);
    expect(metadataIssuerMatches(GITHUB, `${GITHUB}/`)).toBe(false);
  });

  it('another host does not', () => {
    expect(metadataIssuerMatches('https://accounts.goog1e.com', GOOGLE_AS)).toBe(false);
  });

  it('nothing is normalized: case, default port, encoding, a root with query', () => {
    expect(metadataIssuerMatches('https://Accounts.google.com', GOOGLE_AS)).toBe(false);
    expect(metadataIssuerMatches('https://accounts.google.com:443', GOOGLE_ISSUER)).toBe(false);
    expect(metadataIssuerMatches('https://access.stripe.com/%6Dcp', 'https://access.stripe.com/mcp')).toBe(false);
    expect(metadataIssuerMatches('https://accounts.google.com/?x', GOOGLE_ISSUER)).toBe(false);
  });
});

describe('RFC 8414 §3.3 — who refuses', () => {
  it('the login accepts Google and refuses a mismatch with a fixed message', () => {
    expect(() => new LoginOAuthProvider('gmail').saveDiscoveryState(state(GOOGLE_AS, GOOGLE_ISSUER))).not.toThrow();
    expect(() => new LoginOAuthProvider('github').saveDiscoveryState(state(GITHUB, `${GITHUB}/`))).toThrow(
      METADATA_ISSUER_MISMATCH_MESSAGE,
    );
    expect(() => new LoginOAuthProvider('x').saveDiscoveryState(state(GOOGLE_AS, 'https://evil.example'))).toThrow(
      METADATA_ISSUER_MISMATCH_MESSAGE,
    );
    expect(METADATA_ISSUER_MISMATCH_MESSAGE).not.toContain('evil');
  });

  it('a wrapper only records it, once per process, with no value', () => {
    const events: TokenEvent[] = [];
    const p = new KeychainOAuthProvider('x', (e) => events.push(e));
    expect(() => p.saveDiscoveryState(state(GOOGLE_AS, 'https://evil.example'))).not.toThrow();
    p.saveDiscoveryState(state(GOOGLE_AS, 'https://evil.example'));
    expect(events).toEqual([{ event: 'metadata_issuer_mismatch' }]);
    // The binding key stays the discovered URL either way.
    expect(p.currentIssuer()).toBe(GOOGLE_AS);
  });

  it('a wrapper on a consistent server records nothing', () => {
    const events: TokenEvent[] = [];
    new KeychainOAuthProvider('gmail', (e) => events.push(e)).saveDiscoveryState(state(GOOGLE_AS, GOOGLE_ISSUER));
    expect(events).toEqual([]);
  });

  it('end to end: the real SDK auth() stops before registering', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: 'https://mcp.acme.example/mcp', authorization_servers: ['https://as.acme.example'] });
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://as.evil.example',
          authorization_endpoint: 'https://as.acme.example/authorize',
          token_endpoint: 'https://as.acme.example/token',
          registration_endpoint: 'https://as.acme.example/register',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      return new Response('nope', { status: 404 });
    };
    await expect(auth(new LoginOAuthProvider('acme'), { serverUrl: 'https://mcp.acme.example/mcp', fetchFn })).rejects.toThrow(
      METADATA_ISSUER_MISMATCH_MESSAGE,
    );
    expect(calls.some((u) => u.endsWith('/register'))).toBe(false);
  });
});

/** A login provider after discovery against Google (announces iss) or GitHub-like (does not). */
function loginAfter(asUrl: string, issuer: string, issSupported?: boolean): LoginOAuthProvider {
  const p = new LoginOAuthProvider('gmail');
  p.saveDiscoveryState(state(asUrl, issuer, issSupported));
  return p;
}

const cb = (query: string) => interpretCallback(new URL(`http://127.0.0.1:51703${CALLBACK}?${query}`), CALLBACK);

describe('RFC 9207 — iss on the authorization response', () => {
  const google = () => loginAfter(GOOGLE_AS, GOOGLE_ISSUER, true);
  const quiet = () => loginAfter('https://mcp.notion.com', 'https://mcp.notion.com');

  it('exact iss passes, and the code goes on to the exchange', () => {
    const p = google();
    const out = callbackOutcome(cb(`code=C1&state=S&iss=${encodeURIComponent(GOOGLE_ISSUER)}`), (i) => p.checkResponseIss(i));
    expect(out).toMatchObject({ status: 200, settle: { code: 'C1' } });
  });

  it('iss is compared decoded', () => {
    expect(cb('code=C1&iss=https%3A%2F%2Faccounts.google.com')).toEqual({ kind: 'code', code: 'C1', iss: GOOGLE_ISSUER });
  });

  it('Google iss with one slash more is refused — compared with the metadata issuer, not the advertised URL', () => {
    const p = google();
    const out = callbackOutcome(cb(`code=C1&iss=${encodeURIComponent(GOOGLE_AS)}`), (i) => p.checkResponseIss(i));
    expect(out).toEqual({ status: 400, html: CALLBACK_FAILED_HTML, settle: { error: ISS_MISMATCH_MESSAGE } });
  });

  it('absent iss: refused when the server announces it, accepted when it does not', () => {
    const g = google();
    expect(callbackOutcome(cb('code=C1&state=S'), (i) => g.checkResponseIss(i))).toEqual({
      status: 400,
      html: CALLBACK_FAILED_HTML,
      settle: { error: ISS_MISSING_MESSAGE },
    });
    const q = quiet();
    expect(callbackOutcome(cb('code=C1&state=S'), (i) => q.checkResponseIss(i))).toMatchObject({ status: 200, settle: { code: 'C1' } });
    // Not announced, but sent: still checked.
    expect(q.checkResponseIss('https://mcp.notion.com')).toBe('ok');
    expect(q.checkResponseIss('https://mcp.notion.com/')).toBe('mismatch');
  });

  it('an error response with a different iss shows none of error, error_description, error_uri', () => {
    const p = google();
    const out = callbackOutcome(
      cb(
        'error=access_denied&error_description=Click%20here%20evil&error_uri=https%3A%2F%2Fevil.example%2Fhelp' +
          '&iss=https%3A%2F%2Fevil.example',
      ),
      (i) => p.checkResponseIss(i),
    );
    expect(out).toEqual({ status: 400, html: CALLBACK_FAILED_HTML, settle: { error: ISS_MISMATCH_MESSAGE } });
    const said = JSON.stringify(out);
    for (const leak of ['access_denied', 'Click', 'evil.example']) expect(said).not.toContain(leak);
  });

  it('an error response from the right server: the fixed failed page, the error code to xCLAUDE only', () => {
    const p = google();
    const out = callbackOutcome(cb(`error=access_denied&iss=${encodeURIComponent(GOOGLE_ISSUER)}`), (i) => p.checkResponseIss(i));
    expect(out).toEqual({
      status: 400,
      html: CALLBACK_FAILED_HTML,
      settle: { error: 'authorization callback error: access_denied' },
    });
  });

  it('an error value never reaches the page, as markup or as text', () => {
    const p = google();
    const payload = '<script>alert("x")</script>&\'';
    const out = callbackOutcome(
      cb(`error=${encodeURIComponent(payload)}&iss=${encodeURIComponent(GOOGLE_ISSUER)}`),
      (i) => p.checkResponseIss(i),
    );
    if (!('html' in out)) throw new Error('expected a page');
    expect(out.html).toBe(CALLBACK_FAILED_HTML);
    expect(out.html).not.toContain('script');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it.each(['code=A&code=B', 'code=A&state=1&state=2', `code=A&iss=${GOOGLE_ISSUER}&iss=${GOOGLE_ISSUER}`, 'error=x&error=y'])(
    'repeated parameter is refused: %s',
    (query) => {
      expect(cb(query)).toEqual({ kind: 'invalid', reason: 'repeated_parameter' });
      const out = callbackOutcome(cb(query), () => 'ok');
      expect(out).toEqual({ status: 400, html: CALLBACK_FAILED_HTML, settle: { error: REPEATED_PARAMETER_MESSAGE } });
    },
  );

  it('before any discovery there is no issuer to trust: a present iss is a mismatch, an absent one passes', () => {
    const p = new LoginOAuthProvider('x');
    expect(p.checkResponseIss(GOOGLE_ISSUER)).toBe('mismatch');
    expect(p.checkResponseIss(undefined)).toBe('ok');
  });
});
