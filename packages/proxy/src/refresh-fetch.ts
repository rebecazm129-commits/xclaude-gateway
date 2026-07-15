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
//      already rotated: synthesize a 200 with the stored tokens and skip the
//      network — the SDK's saveTokens then re-persists the same value
//      (idempotent) and refreshes its cache;
//   3. otherwise forward the POST and, on success, persist to the Keychain
//      BEFORE releasing — the rotated RT must be visible to other processes at
//      the instant the lock frees, or the reuse window reopens.
// Lock acquisition is fail-open (see refresh-lock.ts): on timeout we proceed
// unlocked, which is exactly today's behavior — never a dead connector.

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { keychainGet, keychainSet } from './keychain.js';
import { tokensAccount, type KeychainOAuthProvider } from './oauth-provider.js';
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
      if (requestRt !== null) {
        const stored = await readStoredTokens(deps.mcp);
        if (stored?.refresh_token !== undefined && stored.refresh_token !== requestRt) {
          deps.provider.noteEvent({ event: 'refresh_coalesced' });
          return new Response(JSON.stringify(stored), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      const response = await baseFetch(url, init);
      if (response.ok && requestRt !== null) {
        // Mirror refreshAuthorization's merge ({ refresh_token: old, ...tokens })
        // so a 200 without a rotated refresh_token never leaves the Keychain
        // RT-less between now and the SDK's own saveTokens.
        try {
          const tokens = (await response.clone().json()) as Record<string, unknown>;
          await keychainSet(
            tokensAccount(deps.mcp),
            JSON.stringify({ refresh_token: requestRt, ...tokens }),
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

async function readStoredTokens(mcp: string): Promise<OAuthTokens | undefined> {
  const raw = await keychainGet(tokensAccount(mcp));
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    // Corrupt blob: no evidence of a cross-process rotation — forward the
    // refresh as-is (the provider's own corrupt_blob handling covers reads on
    // its side).
    return undefined;
  }
}
