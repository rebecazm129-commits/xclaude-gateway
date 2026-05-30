// Unit tests for KeychainOAuthProvider (Hito 6 Fase 4 sub-step 4.b.1).
// keychain.js is mocked with an in-memory Map; the real macOS Keychain is
// never touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  getCalls: 0,
  spawnCalls: [] as Array<{ command: string; args: readonly string[] }>,
}));

vi.mock('../src/keychain.js', () => ({
  keychainSet: async (account: string, value: string): Promise<void> => {
    mocks.store.set(account, value);
  },
  keychainGet: async (account: string): Promise<string | null> => {
    mocks.getCalls++;
    return mocks.store.has(account) ? (mocks.store.get(account) as string) : null;
  },
  keychainDelete: async (account: string): Promise<void> => {
    mocks.store.delete(account);
  },
}));

// node:child_process se mockea porque LoginOAuthProvider.redirectToAuthorization
// invoca /usr/bin/open. KeychainOAuthProvider no llama a spawn, así que sus tests
// no se ven afectados; los tests existentes pasan idénticos.
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    mocks.spawnCalls.push({ command, args });
    return { unref: (): void => undefined };
  },
}));

// Import AFTER the mock (vitest hoists vi.mock regardless, but order is clearer).
import { KeychainOAuthProvider, LoginOAuthProvider, ReauthRequiredError } from '../src/oauth-provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('KeychainOAuthProvider', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.getCalls = 0;
    mocks.spawnCalls.length = 0;
  });

  describe('redirectUrl + clientMetadata', () => {
    it('redirectUrl is a non-empty string', () => {
      const p = new KeychainOAuthProvider('notion');
      expect(typeof p.redirectUrl).toBe('string');
      expect(p.redirectUrl.length).toBeGreaterThan(0);
    });

    it('clientMetadata.redirect_uris has at least one entry', () => {
      const p = new KeychainOAuthProvider('notion');
      expect(p.clientMetadata.redirect_uris.length).toBeGreaterThanOrEqual(1);
    });

    it('clientMetadata.redirect_uris[0] matches redirectUrl', () => {
      const p = new KeychainOAuthProvider('notion');
      expect(p.clientMetadata.redirect_uris[0]).toBe(p.redirectUrl);
    });
  });

  describe('round-trip with namespaced accounts', () => {
    it('tokens persisted under "<mcp>:tokens"', async () => {
      const p = new KeychainOAuthProvider('notion');
      const tokens: OAuthTokens = {
        access_token: 'abc',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r1',
      };
      await p.saveTokens(tokens);
      expect(mocks.store.has('notion:tokens')).toBe(true);
      const got = await p.tokens();
      expect(got).toEqual(tokens);
    });

    it('clientInformation persisted under "<mcp>:client"', async () => {
      const p = new KeychainOAuthProvider('notion');
      const info: OAuthClientInformationFull = {
        client_id: 'cid-123',
        redirect_uris: ['http://127.0.0.1:51703/xcg-callback'],
      };
      await p.saveClientInformation(info);
      expect(mocks.store.has('notion:client')).toBe(true);
      const got = await p.clientInformation();
      expect(got).toEqual(info);
    });

    it('codeVerifier persisted under "<mcp>:verifier"', async () => {
      const p = new KeychainOAuthProvider('notion');
      await p.saveCodeVerifier('pkce-verifier-string');
      expect(mocks.store.has('notion:verifier')).toBe(true);
      const got = await p.codeVerifier();
      expect(got).toBe('pkce-verifier-string');
    });

    it('namespacing isolates two providers with different mcp names', async () => {
      const a = new KeychainOAuthProvider('notion');
      const b = new KeychainOAuthProvider('linear');
      await a.saveTokens({ access_token: 'A', token_type: 'Bearer' });
      await b.saveTokens({ access_token: 'B', token_type: 'Bearer' });
      expect(await a.tokens()).toEqual({ access_token: 'A', token_type: 'Bearer' });
      expect(await b.tokens()).toEqual({ access_token: 'B', token_type: 'Bearer' });
      expect(mocks.store.has('notion:tokens')).toBe(true);
      expect(mocks.store.has('linear:tokens')).toBe(true);
    });
  });

  describe('undefined / throw on missing', () => {
    it('tokens() returns undefined when account does not exist', async () => {
      const p = new KeychainOAuthProvider('notion');
      expect(await p.tokens()).toBeUndefined();
    });

    it('clientInformation() returns undefined when account does not exist', async () => {
      const p = new KeychainOAuthProvider('notion');
      expect(await p.clientInformation()).toBeUndefined();
    });

    it('codeVerifier() throws when no verifier stored', async () => {
      const p = new KeychainOAuthProvider('notion');
      await expect(p.codeVerifier()).rejects.toThrow(/no PKCE code verifier stored/);
    });
  });

  describe('redirectToAuthorization', () => {
    it('throws ReauthRequiredError with err.mcp === mcp name', () => {
      const p = new KeychainOAuthProvider('notion');
      let caught: unknown;
      try {
        p.redirectToAuthorization(new URL('https://example.com/authorize'));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReauthRequiredError);
      expect((caught as ReauthRequiredError).mcp).toBe('notion');
    });
  });

  describe('invalidateCredentials', () => {
    async function seedAll(p: KeychainOAuthProvider): Promise<void> {
      await p.saveTokens({ access_token: 'x', token_type: 'Bearer' });
      await p.saveClientInformation({ client_id: 'cid', redirect_uris: ['http://x'] });
      await p.saveCodeVerifier('v');
    }

    it("'all' deletes the 3 accounts", async () => {
      const p = new KeychainOAuthProvider('notion');
      await seedAll(p);
      await p.invalidateCredentials('all');
      expect(mocks.store.has('notion:tokens')).toBe(false);
      expect(mocks.store.has('notion:client')).toBe(false);
      expect(mocks.store.has('notion:verifier')).toBe(false);
    });

    it("'tokens' deletes only tokens", async () => {
      const p = new KeychainOAuthProvider('notion');
      await seedAll(p);
      await p.invalidateCredentials('tokens');
      expect(mocks.store.has('notion:tokens')).toBe(false);
      expect(mocks.store.has('notion:client')).toBe(true);
      expect(mocks.store.has('notion:verifier')).toBe(true);
    });

    it("'client' deletes only client", async () => {
      const p = new KeychainOAuthProvider('notion');
      await seedAll(p);
      await p.invalidateCredentials('client');
      expect(mocks.store.has('notion:tokens')).toBe(true);
      expect(mocks.store.has('notion:client')).toBe(false);
      expect(mocks.store.has('notion:verifier')).toBe(true);
    });

    it("'verifier' deletes only verifier", async () => {
      const p = new KeychainOAuthProvider('notion');
      await seedAll(p);
      await p.invalidateCredentials('verifier');
      expect(mocks.store.has('notion:tokens')).toBe(true);
      expect(mocks.store.has('notion:client')).toBe(true);
      expect(mocks.store.has('notion:verifier')).toBe(false);
    });

    it("'discovery' deletes nothing", async () => {
      const p = new KeychainOAuthProvider('notion');
      await seedAll(p);
      await p.invalidateCredentials('discovery');
      expect(mocks.store.has('notion:tokens')).toBe(true);
      expect(mocks.store.has('notion:client')).toBe(true);
      expect(mocks.store.has('notion:verifier')).toBe(true);
    });
  });

  describe('tokens() cache (avoid per-request /usr/bin/security spawn)', () => {
    it('after saveTokens, consecutive tokens() calls do NOT hit keychainGet', async () => {
      const p = new KeychainOAuthProvider('notion');
      await p.saveTokens({ access_token: 'cached', token_type: 'Bearer' });
      const before = mocks.getCalls;
      const t1 = await p.tokens();
      const t2 = await p.tokens();
      const after = mocks.getCalls;
      expect(t1).toEqual({ access_token: 'cached', token_type: 'Bearer' });
      expect(t2).toEqual({ access_token: 'cached', token_type: 'Bearer' });
      expect(after - before).toBe(0);
    });

    it('first tokens() reads Keychain once; subsequent calls reuse the cache', async () => {
      // Pre-seed directly (simulating tokens previously stored on disk).
      mocks.store.set(
        'notion:tokens',
        JSON.stringify({ access_token: 'preloaded', token_type: 'Bearer' }),
      );
      const p = new KeychainOAuthProvider('notion');
      const before = mocks.getCalls;
      const t1 = await p.tokens();
      const t2 = await p.tokens();
      const t3 = await p.tokens();
      const after = mocks.getCalls;
      expect(t1).toEqual({ access_token: 'preloaded', token_type: 'Bearer' });
      expect(t2).toEqual(t1);
      expect(t3).toEqual(t1);
      expect(after - before).toBe(1);
    });

    it('absent token cached as undefined; second tokens() does NOT re-hit keychainGet', async () => {
      const p = new KeychainOAuthProvider('notion');
      const before = mocks.getCalls;
      const t1 = await p.tokens();
      const t2 = await p.tokens();
      const after = mocks.getCalls;
      expect(t1).toBeUndefined();
      expect(t2).toBeUndefined();
      expect(after - before).toBe(1);
    });

    it('saveTokens primes the cache: tokens() reflects the new value with no keychainGet', async () => {
      const p = new KeychainOAuthProvider('notion');
      // Force initial load of "absent" into the cache.
      await p.tokens();
      const before = mocks.getCalls;
      await p.saveTokens({ access_token: 'fresh', token_type: 'Bearer' });
      const t = await p.tokens();
      const after = mocks.getCalls;
      expect(t).toEqual({ access_token: 'fresh', token_type: 'Bearer' });
      expect(after - before).toBe(0);
    });

    it("invalidateCredentials('tokens') clears the cache: next tokens() returns undefined without re-reading", async () => {
      const p = new KeychainOAuthProvider('notion');
      await p.saveTokens({ access_token: 'will-be-gone', token_type: 'Bearer' });
      await p.invalidateCredentials('tokens');
      const before = mocks.getCalls;
      const t = await p.tokens();
      const after = mocks.getCalls;
      expect(t).toBeUndefined();
      expect(mocks.store.has('notion:tokens')).toBe(false);
      expect(after - before).toBe(0); // cache cleared to {v:undefined}, no Keychain read needed
    });

    it("invalidateCredentials('all') also clears the tokens cache", async () => {
      const p = new KeychainOAuthProvider('notion');
      await p.saveTokens({ access_token: 'will-be-gone', token_type: 'Bearer' });
      await p.invalidateCredentials('all');
      const t = await p.tokens();
      expect(t).toBeUndefined();
    });
  });

  describe('LoginOAuthProvider', () => {
    it('redirectToAuthorization invokes spawn with /usr/bin/open and the URL string, does NOT throw', () => {
      const p = new LoginOAuthProvider('notion');
      const url = new URL('https://example.com/authorize?client_id=x&state=abc');
      expect(() => p.redirectToAuthorization(url)).not.toThrow();
      expect(mocks.spawnCalls).toHaveLength(1);
      const [call] = mocks.spawnCalls;
      expect(call).toBeDefined();
      if (!call) return;
      expect(call.command).toBe('/usr/bin/open');
      expect(call.args).toEqual([url.toString()]);
    });

    it('inherits the Keychain backing: saveTokens persists under "<mcp>:tokens"', async () => {
      const p = new LoginOAuthProvider('linear');
      await p.saveTokens({ access_token: 'xx', token_type: 'Bearer' });
      expect(mocks.store.has('linear:tokens')).toBe(true);
    });

    it('inherits redirectUrl from KeychainOAuthProvider (same loopback URI)', () => {
      const a = new KeychainOAuthProvider('notion');
      const b = new LoginOAuthProvider('notion');
      expect(b.redirectUrl).toBe(a.redirectUrl);
    });
  });
});
