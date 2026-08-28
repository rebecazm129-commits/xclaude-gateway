// Single-flight interceptor for OAuth token refreshes, wired as the transport's
// opts.fetch (and as auth()'s fetchFn in the login flow). The SDK gives no hook
// that wraps the whole refresh (tokens() → refreshAuthorization → saveTokens),
// but it DOES route the token-endpoint POST through the injected fetch, and that
// request is self-identifying: executeTokenRequest posts URLSearchParams with
// grant_type=refresh_token. Everything else — MCP data requests on the same
// transport, authorization_code exchanges — passes through untouched, so the
// hot path (_commonHeaders → tokens() → in-memory cache) never sees the lock.
//
// Inside the critical section (single function, try/finally — no cross-method
// release to leak):
//   1. reread the Keychain directly (bypassing the provider's cache);
//   2. if the stored RT differs from the one in the request, another process
//      already rotated. If its access token is STILL VALID, synthesize a 200
//      with the stored tokens and skip the network — the SDK's saveTokens then
//      re-persists the same value (idempotent) and refreshes its cache. If it
//      is past expiry (or its age is unknown), replaying it would hand the
//      caller a dead token: do a REAL refresh with the STORED refresh token
//      instead — still inside this same critical section, so the rotating RT is
//      never used by two processes at once;
//   3. otherwise forward the POST and, on success, persist to the Keychain
//      BEFORE releasing — the rotated RT must be visible to other processes at
//      the instant the lock frees, or the reuse window reopens.
// Lock acquisition is fail-open (see refresh-lock.ts): on timeout we proceed
// unlocked, which is exactly today's behavior — never a dead connector.

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { keychainGet, keychainSet } from './keychain.js';
import {
  accessTokenUsable,
  tokensAccount,
  type KeychainOAuthProvider,
  type StoredTokens,
} from './oauth-provider.js';
import { acquireRefreshLock, type RefreshLockOptions } from './refresh-lock.js';

export interface RefreshFetchDeps {
  mcp: string;
  /** Lock location; callers use refreshLockPath(mcp). Explicit for tests. */
  lockPath: string;
  /** Event channel: refresh_coalesced / lock_timeout route through the provider
   *  so lastTokenEvent() covers them for oauth_failed triage. */
  provider: KeychainOAuthProvider;
  /** Underlying fetch. Injectable for tests; defaults to the global. */
  baseFetch?: FetchLike;
  lockOptions?: RefreshLockOptions;
}

export function createRefreshFetch(deps: RefreshFetchDeps): FetchLike {
  const baseFetch: FetchLike = deps.baseFetch ?? ((url, init) => fetch(url, init));

  return async (url, init) => {
    const body = init?.body;
    // Shape pinned against the vendored SDK by the anti-drift test: if an SDK
    // upgrade changes how executeTokenRequest posts the refresh grant, that
    // test fails instead of this check silently passing everything through.
    if (!(body instanceof URLSearchParams) || body.get('grant_type') !== 'refresh_token') {
      return baseFetch(url, init);
    }
    const requestRt = body.get('refresh_token');

    const lock = await acquireRefreshLock(deps.lockPath, deps.lockOptions);
    if (!lock.acquired) {
      deps.provider.noteEvent({ event: 'lock_timeout', waitedMs: lock.waitedMs });
      return baseFetch(url, init);
    }
    try {
      // The refresh token this round trip will actually spend: ours, unless a
      // sibling process already rotated and left a newer one behind.
      let grantRt = requestRt;

      if (requestRt !== null) {
        const stored = await readStoredTokens(deps.mcp);
        if (stored?.refresh_token !== undefined && stored.refresh_token !== requestRt) {
          if (accessTokenUsable(stored, Date.now())) {
            deps.provider.noteEvent({ event: 'refresh_coalesced' });
            return new Response(JSON.stringify(stored), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          // Rotated AND stale: replaying it is what left Notion answering 401
          // to every call on 27/08. Spend the STORED refresh token — ours was
          // superseded and the server would reject it as reuse.
          deps.provider.noteEvent({ event: 'refresh_coalesced_stale' });
          grantRt = stored.refresh_token;
        }
      }

      const response = await baseFetch(
        url,
        grantRt !== null && grantRt !== requestRt ? withRefreshToken(init, grantRt) : init,
      );
      if (response.ok && grantRt !== null) {
        // Mirror refreshAuthorization's merge ({ refresh_token: old, ...tokens })
        // so a 200 without a rotated refresh_token never leaves the Keychain
        // RT-less between now and the SDK's own saveTokens. obtained_at dates
        // the access token we just received; the SDK strips it on parse, so
        // saveTokens re-applies it (oauth-provider.stampObtainedAt).
        try {
          const tokens = (await response.clone().json()) as Record<string, unknown>;
          await keychainSet(
            tokensAccount(deps.mcp),
            JSON.stringify({ refresh_token: grantRt, ...tokens, obtained_at: Date.now() }),
          );
        } catch {
          // Non-JSON 200: the SDK's schema parse will reject it downstream;
          // nothing trustworthy to persist here.
        }
      }
      return response;
    } finally {
      await lock.release();
    }
  };
}

// Rebuilds the token-endpoint POST with a different refresh_token, leaving
// every other field of the SDK's request untouched.
function withRefreshToken(init: RequestInit | undefined, rt: string): RequestInit {
  const next = new URLSearchParams(init?.body as URLSearchParams);
  next.set('refresh_token', rt);
  return { ...init, body: next };
}

async function readStoredTokens(mcp: string): Promise<StoredTokens | undefined> {
  const raw = await keychainGet(tokensAccount(mcp));
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    // Corrupt blob: no evidence of a cross-process rotation — forward the
    // refresh as-is (the provider's own corrupt_blob handling covers reads on
    // its side).
    return undefined;
  }
}
