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
//
// Every token-endpoint POST — locked AND fail-open — goes through postAndReport,
// which reports a non-2xx as proxy.token/refresh_rejected. This interceptor is
// the last place the server's own reason exists: the SDK turns the response into
// parseErrorResponse → InvalidGrantError → invalidateCredentials('tokens'), so
// what reaches the trail today is a bare 'invalidated' with no way to tell a
// revoked grant from an expired RT. Reporting from both paths is the point: the
// unlocked one is precisely the one we most need to see.

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { attachMaskSecrets } from './events.js';
import { keychainGet, keychainSet } from './keychain.js';
import {
  accessTokenUsable,
  issuersMatch,
  tokensAccount,
  type KeychainOAuthProvider,
  type StoredTokens,
  type TokenEvent,
} from './oauth-provider.js';
import { acquireRefreshLock, type RefreshLockOptions } from './refresh-lock.js';

/** Sanity guard on the raw error body: above this we do not even try to parse.
 *  64 KB matches MAX_LEAF_BYTES in events.ts, is far above any real OAuth error
 *  body, and costs nothing measurable to JSON.parse. */
const OAUTH_ERROR_BODY_MAX = 64 * 1024;
/** RFC 6749 §5.2 `error` is a bare ASCII token (invalid_grant, invalid_client,
 *  …); 64 is far above any real code and bounds a hostile server. */
const OAUTH_ERROR_MAX = 64;
/** `error_description` is free-form human text — see readOAuthError. */
const OAUTH_ERROR_DESCRIPTION_MAX = 200;

/** Stand-in printed where the spent refresh token was echoed back to us. */
const RT_REDACTION = '[redacted:rt]';

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
    // The single network path for the token-endpoint POST, shared by the locked
    // flow and the fail-open one. `spentRt` is the refresh token this round trip
    // actually burned — needed to redact it back out of the server's prose.
    const postAndReport = async (
      reqInit: RequestInit | undefined,
      spentRt: string | null,
    ): Promise<Response> => {
      const response = await baseFetch(url, reqInit);
      if (!response.ok) {
        const { error, description } = await readOAuthError(response, spentRt);
        const event: TokenEvent = {
          event: 'refresh_rejected',
          status: response.status,
          ...(error !== undefined ? { oauthError: error } : {}),
          ...(description !== undefined ? { oauthErrorDescription: description } : {}),
        };
        // Layer 2 of the redaction. Layer 1 (readOAuthError) is a literal
        // replace, so it misses an echo the server re-encoded or clipped;
        // this tags the event so EventSink masks the value out of the
        // SERIALIZED line, wherever it ended up. The Symbol survives the
        // `{ type: 'proxy.token', ...e }` spread in main.ts — see the
        // MASK_SECRETS note in events.ts.
        if (spentRt !== null) {
          attachMaskSecrets(event, [{ value: spentRt, type: 'oauth_refresh_token' }]);
        }
        deps.provider.noteEvent(event);
      }
      return response;
    };

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
      return postAndReport(init, requestRt);
    }
    try {
      // The refresh token this round trip will actually spend: ours, unless a
      // sibling process already rotated and left a newer one behind.
      let grantRt = requestRt;
      // The authorization server this refresh is for: the one auth() discovered
      // in this run (provider.currentIssuer), never the Keychain or a response.
      const expected = deps.provider.currentIssuer();
      // The issuer of the set whose refresh token is spent, carried onto the
      // rotated set we persist. Undefined for a set written before binding.
      let spentIssuer: string | undefined;

      const stored = requestRt !== null ? await readStoredTokens(deps.mcp) : undefined;
      // A sibling's set is usable only when it belongs to THIS authorization
      // server (SEP-2352), or predates binding (no stamp: the SDK uses those
      // as-is too). One bound elsewhere is never coalesced onto nor spent here:
      // its refresh token must not reach this server's token endpoint.
      const storedUsable =
        stored !== undefined &&
        (typeof stored.issuer !== 'string' || (expected !== null && issuersMatch(stored.issuer, expected)));
      if (stored !== undefined && storedUsable && stored.refresh_token === requestRt) {
        spentIssuer = stored.issuer; // our own set, as stored
      }

      if (requestRt !== null && stored !== undefined && storedUsable) {
        if (stored.refresh_token !== undefined && stored.refresh_token !== requestRt) {
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
          spentIssuer = stored.issuer;
        }
      }

      const response = await postAndReport(
        grantRt !== null && grantRt !== requestRt ? withRefreshToken(init, grantRt) : init,
        grantRt,
      );
      if (response.ok && grantRt !== null) {
        // Mirror refreshAuthorization's merge ({ refresh_token: old, ...tokens })
        // so a 200 without a rotated refresh_token never leaves the Keychain
        // RT-less between now and the SDK's own saveTokens. obtained_at dates
        // the access token we just received; the SDK strips it on parse, so
        // saveTokens re-applies it (oauth-provider.stampObtainedAt).
        //
        // issuer: the rotated set belongs to the server of the set it replaces
        // — the spent set's stamp, else the server this run discovered. An
        // `issuer` in the token RESPONSE is dropped, never stored: the server
        // answering does not get to say which server it is (the SDK does the
        // same, and restamps on its own saveTokens right after).
        try {
          const tokens = { ...((await response.clone().json()) as Record<string, unknown>) };
          delete tokens['issuer'];
          const issuer = spentIssuer ?? expected ?? undefined;
          await keychainSet(
            tokensAccount(deps.mcp),
            JSON.stringify({
              refresh_token: grantRt,
              ...tokens,
              ...(issuer !== undefined ? { issuer } : {}),
              obtained_at: Date.now(),
            }),
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

/**
 * Reads the OAuth error out of a rejected token-endpoint response WITHOUT
 * consuming it: the SDK's parseErrorResponse does `await response.text()` on
 * this very same Response downstream, so the clone is load-bearing, not
 * cosmetic — drop it and every refresh failure turns into a body-already-used
 * error inside the SDK.
 *
 * PRIVACY. RFC 6749 §5.2 constrains error_description's CHARSET (values "MUST
 * NOT include characters outside the set %x20-21 / %x23-5B / %x5D-7E") and
 * describes it as "human-readable ASCII text providing additional information,
 * used to assist the client developer" — it does NOT forbid echoing the
 * submitted credential, and implementations exist that name the offending token
 * in the prose. So we redact the spent RT out of the RAW body before parsing:
 * that covers every field, not just the one we read, and it runs BEFORE the
 * truncation so a token straddling the cut can never be left half-present (the
 * failure mode EventSink.emit warns about). The replacement is quote- and
 * backslash-free, so a redaction inside a JSON string leaves valid JSON.
 */
async function readOAuthError(
  response: Response,
  spentRt: string | null,
): Promise<{ error?: string; description?: string }> {
  try {
    const raw = await response.clone().text();
    // clone().text() has already buffered the whole body, so slicing here would
    // save no memory — it would only corrupt the JSON and lose the error
    // entirely (a body over the old 4 KB cut parsed as garbage and reported
    // status alone). The cap's only job is deciding whether this can plausibly
    // be an OAuth error worth parsing; a megabyte of HTML is not one.
    if (raw.length > OAUTH_ERROR_BODY_MAX) return {};
    // Redact on the RAW body: before the parse, so it covers every field, and
    // before any field truncation, so a token straddling the cut is never left
    // half-present.
    const text = spentRt !== null && spentRt !== '' ? raw.split(spentRt).join(RT_REDACTION) : raw;
    const body = JSON.parse(text) as Record<string, unknown>;
    return {
      error: typeof body.error === 'string' ? body.error.slice(0, OAUTH_ERROR_MAX) : undefined,
      description:
        typeof body.error_description === 'string'
          ? body.error_description.slice(0, OAUTH_ERROR_DESCRIPTION_MAX)
          : undefined,
    };
  } catch {
    // Non-JSON body (an HTML error page), empty body, or a body we could not
    // read: the status alone is still signal. Telemetry never fails a refresh.
    return {};
  }
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
