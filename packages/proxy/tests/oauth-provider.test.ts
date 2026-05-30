// Unit tests for KeychainOAuthProvider (Hito 6 Fase 4 sub-step 4.b.1).
// keychain.js is mocked with an in-memory Map; the real macOS Keychain is
// never touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Import AFTER the mock (vitest hoists vi.mock regardless, but order is clearer).
import { KeychainOAuthProvider, ReauthRequiredError } from '../src/oauth-provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('KeychainOAuthProvider', () => {
  beforeEach(() => {
    mocks.store.clear();
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
});
