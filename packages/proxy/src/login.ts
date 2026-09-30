import http from 'node:http';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { LoginOAuthProvider } from './oauth-provider.js';
import { createRefreshFetch } from './refresh-fetch.js';
import { refreshLockPath } from './refresh-lock.js';
import { hasStoredCredentials } from './credentials.js';
import { recordOAuthAuthorizedToDisk, type AuthorizationCapture } from './oauth-authorized.js';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginArgs {
  url: string;
  name: string;
  scope?: string;
}

// --- DI seam so runLogin's branches are unit-testable; all default to real impls. ---
export interface LoginTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  finishAuth(code: string): Promise<void>;
  close(): Promise<void>;
}
export interface CallbackHandle {
  waitForCode(): Promise<string>;
  close(): void;
}
export interface RunLoginDeps {
  authFn?: (
    provider: OAuthClientProvider,
    opts: { serverUrl: string; scope?: string; fetchFn?: FetchLike },
  ) => Promise<'AUTHORIZED' | 'REDIRECT'>;
  hasStored?: (name: string) => Promise<boolean>;
  discoverFn?: (url: string) => Promise<unknown>;
  createTransport?: (url: string, provider: LoginOAuthProvider, fetchFn?: FetchLike) => LoginTransport;
  startCallback?: (provider: LoginOAuthProvider) => Promise<CallbackHandle>;
  /** Writes proxy.oauth_authorized + the reference (default: the real data folder). */
  recordAuthorization?: (name: string, capture: AuthorizationCapture) => void;
}

// `iss` (RFC 9207) is carried decoded, and only when present, so a callback
// without it reads exactly as it always did.
export type CallbackResult =
  | { kind: 'code'; code: string; iss?: string }
  | { kind: 'error'; error: string; iss?: string }
  | { kind: 'invalid'; reason: 'repeated_parameter' }
  | { kind: 'ignore' };

/** Parameters an authorization response carries at most once. A repeat means
 *  two values to choose between — the response is refused, not interpreted. */
const SINGLE_PARAMS = ['code', 'state', 'iss', 'error'] as const;

export function interpretCallback(reqUrl: URL, callbackPath: string): CallbackResult {
  if (reqUrl.pathname !== callbackPath) return { kind: 'ignore' };
  if (SINGLE_PARAMS.some((p) => reqUrl.searchParams.getAll(p).length > 1)) {
    return { kind: 'invalid', reason: 'repeated_parameter' };
  }
  const iss = reqUrl.searchParams.get('iss');
  const withIss = iss !== null ? { iss } : {};
  const error = reqUrl.searchParams.get('error');
  if (error) return { kind: 'error', error, ...withIss };
  const code = reqUrl.searchParams.get('code');
  if (code) return { kind: 'code', code, ...withIss };
  return { kind: 'error', error: 'missing_code', ...withIss };
}

/** What the loopback listener answers and whether the login continues. */
export type CallbackOutcome =
  | { status: 404 }
  | { status: 200 | 400; html: string; settle: { code: string } | { error: string } };

/** Fixed words for every refused response: nothing the server or the URL sent
 *  (error, error_description, error_uri, iss) reaches the page or the error. */
export const CALLBACK_REFUSED_HTML = '<html><body>xCLAUDE login failed. You can close this tab.</body></html>';
export const ISS_MISMATCH_MESSAGE =
  'authorization response rejected: it does not come from the expected authorization server (RFC 9207)';
export const ISS_MISSING_MESSAGE =
  'authorization response rejected: the authorization server did not identify itself (RFC 9207)';
export const REPEATED_PARAMETER_MESSAGE = 'authorization response rejected: a parameter was repeated';

/** Every value placed in the callback page goes through this: the page is
 *  served from 127.0.0.1 and its query is whatever the redirect carried. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The decision for one callback request, pure. RFC 9207 is checked HERE, on
 * the listener, so a code whose `iss` does not match never reaches
 * finishAuth: the exchange only ever sees a code that passed.
 */
export function callbackOutcome(
  result: CallbackResult,
  checkIss: (iss: string | undefined) => 'ok' | 'mismatch' | 'missing',
): CallbackOutcome {
  if (result.kind === 'ignore') return { status: 404 };
  if (result.kind === 'invalid') {
    return { status: 400, html: CALLBACK_REFUSED_HTML, settle: { error: REPEATED_PARAMETER_MESSAGE } };
  }
  const verdict = checkIss(result.iss);
  if (verdict !== 'ok') {
    const message = verdict === 'mismatch' ? ISS_MISMATCH_MESSAGE : ISS_MISSING_MESSAGE;
    return { status: 400, html: CALLBACK_REFUSED_HTML, settle: { error: message } };
  }
  if (result.kind === 'error') {
    return {
      status: 400,
      html: `<html><body>xCLAUDE login failed: ${escapeHtml(result.error)}. You can close this tab.</body></html>`,
      settle: { error: `authorization callback error: ${result.error}` },
    };
  }
  return {
    status: 200,
    html: '<html><body>xCLAUDE: login complete. You can close this tab.</body></html>',
    settle: { code: result.code },
  };
}

// Drives the initialize handshake and reports whether the SDK redirected to the
// browser. Missing/expired token → the first send() triggers 401 → discovery →
// DCR → redirectToAuthorization (opens the browser) and the SDK throws
// UnauthorizedError: returns true (caller must wait for the loopback callback).
// A still-valid token → the credential is accepted, send() resolves, no redirect:
// returns false (caller is done — nothing to authorize). Any other error is a
// real failure (discovery/DCR/network) and propagates. Extracted as the unit-
// testable seam for the 200-vs-401 decision (runLogin's full flow stays manual).
export async function probeAuthorization(send: () => Promise<void>): Promise<boolean> {
  try {
    await send();
    return false; // 200: token still valid, no browser redirect happened
  } catch (err) {
    if (err instanceof UnauthorizedError) return true; // REDIRECT: browser opened
    throw err;
  }
}

function defaultCreateTransport(
  url: string,
  provider: LoginOAuthProvider,
  fetchFn?: FetchLike,
): LoginTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    authProvider: provider,
    fetch: fetchFn,
  }) as unknown as LoginTransport;
}

// Protected-resource discovery (RFC 9728), path-aware with root fallback.
// We do NOT use the SDK's discoverOAuthProtectedResourceMetadata: its
// fetchWithCorsRetry swallows network TypeErrors into `undefined`, which it then
// reports with the SAME "does not implement Protected Resource Metadata" error as
// a real 404 — conflating a down network with "no OAuth". Here we distinguish:
//   200            -> metadata present (return it)
//   404 (both URLs) -> no metadata (return undefined)  => "no auth required"
//   other non-ok   -> throw (5xx, etc.)                => propagate (login fails)
//   fetch throws    -> NOT caught (DNS/conn refused)    => propagate (login fails)
async function defaultDiscover(url: string): Promise<unknown> {
  const u = new URL(url);
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${u.pathname}`, u.origin),
    new URL('/.well-known/oauth-protected-resource', u.origin),
  ];
  for (const candidate of candidates) {
    const res = await fetch(candidate, { headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`HTTP ${res.status} discovering protected-resource metadata at ${candidate.href}`);
    return await res.json();
  }
  return undefined;
}

// Real loopback listener on the fixed product redirect (127.0.0.1:51703/xcg-callback).
// Awaits listen() so EADDRINUSE fails fast (as before).
async function defaultStartCallback(provider: LoginOAuthProvider): Promise<CallbackHandle> {
  const redirect = new URL(provider.redirectUrl);
  const port = Number(redirect.port);
  const callbackPath = redirect.pathname;
  let timer: NodeJS.Timeout | undefined;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const outcome = callbackOutcome(interpretCallback(reqUrl, callbackPath), (iss) => provider.checkResponseIss(iss));
    if (outcome.status === 404) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(outcome.status, { 'content-type': 'text/html' }).end(outcome.html);
    if ('code' in outcome.settle) resolveCode(outcome.settle.code);
    else rejectCode(new Error(outcome.settle.error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE: the most likely holder of the fixed port is another login
      // of ours still in progress (F3-01) — say so instead of pointing the
      // user at a generic "conflicting process".
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is in use — another sign-in may still be in progress; wait for it to finish and retry`,
            )
          : err,
      );
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    waitForCode: () =>
      Promise.race([
        codePromise,
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error('timed out waiting for the browser authorization callback')),
            CALLBACK_TIMEOUT_MS,
          );
        }),
      ]),
    close: () => {
      if (timer) clearTimeout(timer);
      server.close();
    },
  };
}

export async function runLogin({ url, name, scope }: LoginArgs, deps: RunLoginDeps = {}): Promise<void> {
  const authFn = deps.authFn ?? ((p, o) => auth(p, o));
  const hasStored = deps.hasStored ?? hasStoredCredentials;
  const discoverFn = deps.discoverFn ?? defaultDiscover;
  const createTransport = deps.createTransport ?? defaultCreateTransport;
  const startCallback = deps.startCallback ?? defaultStartCallback;
  const recordAuthorization = deps.recordAuthorization ?? recordOAuthAuthorizedToDisk;

  const provider = new LoginOAuthProvider(name);
  // The login flow refreshes too (the "stored/refreshed credentials" path drives
  // auth() with an existing RT), so it takes the same per-connector single-flight
  // as the wrappers: a reconnect racing a wrapper refresh must not burn the RT.
  const refreshFetch = createRefreshFetch({ mcp: name, lockPath: refreshLockPath(name), provider });
  const callback = await startCallback(provider);
  const transport = createTransport(url, provider, refreshFetch);
  // After a successful finishAuth only. The capture is null unless a code was
  // exchanged in this process. Best-effort: the tokens are already stored, so
  // an audit write failure is reported, never turned into a failed login.
  const recordIfAuthorized = (): void => {
    const capture = provider.authorizationCapture();
    if (capture === null) return;
    try {
      recordAuthorization(name, capture);
    } catch (err) {
      process.stderr.write(
        `xcg-proxy login: could not record the authorization for "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  try {
    await transport.start();

    // General rule: an explicit scope (catalog or LoginArgs) ⇒ authorize with OUR
    // scope BEFORE the first initialize. Some servers (e.g. GitHub) answer initialize
    // with a 401 whose WWW-Authenticate carries resource_metadata but NO scope, so the
    // SDK transport's internal auth() would resolve the scope from the PRM's
    // scopes_supported (SEP-835 priority #2) — every scope the server advertises. By
    // driving auth() directly on the provider with the caller's scope first (priority
    // #1), the authorization URL carries exactly that scope; the resulting token then
    // satisfies initialize with no 401 and no internal auth. We do NOT re-send a
    // verifying initialize here (the REDIRECT and deferred paths below don't either):
    // a single-shot loopback callback can't serve a second upscope round-trip.
    //
    // No explicit scope (DCR connectors like Atlassian) → fall through unchanged.
    // Note: Gmail/Calendar/Drive carry explicit scopes too, so they now enter this
    // branch rather than the deferred path (accepted; revisited with their own login
    // trigger).
    if (scope !== undefined && scope !== '') {
      // Confirm the server actually requires authorization (RFC 9728 metadata).
      // Absent → nothing to authorize (mirrors the deferred path's decision).
      const metadata = await discoverFn(url);
      if (!metadata) {
        process.stderr.write(`xcg-proxy login: "${name}" — no authorization required by server\n`);
        return;
      }
      // Drive auth() WITHOUT a catch: a real auth failure must surface as a login
      // error, never a false success.
      const result = await authFn(provider, { serverUrl: url, scope, fetchFn: refreshFetch });
      if (result === 'REDIRECT') {
        const code = await callback.waitForCode();
        await transport.finishAuth(code);
        recordIfAuthorized();
        process.stderr.write(
          `xcg-proxy login: authorized "${name}" with scope "${scope}"; token stored in Keychain\n`,
        );
      } else {
        process.stderr.write(`xcg-proxy login: authorized "${name}" via stored/refreshed credentials\n`);
      }
      return;
    }

    // The first send() is where the SDK runs auth: a missing/expired token
    // triggers 401 -> DCR -> redirectToAuthorization (opens the browser) and the
    // SDK throws UnauthorizedError; a still-valid token is accepted (200) and no
    // redirect happens. We must wait for the loopback callback ONLY in the former.
    const redirected = await probeAuthorization(() =>
      transport.send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'xcg-proxy-login', version: '0.0.0' },
        },
      }),
    );

    if (redirected) {
      // 401 path: the SDK already opened the browser during send(); wait for the code.
      const code = await callback.waitForCode();
      await transport.finishAuth(code);
      recordIfAuthorized();
      process.stderr.write(`xcg-proxy login: authorized "${name}"; token stored in Keychain\n`);
      return;
    }

    // initialize returned 200 (no 401 challenge).
    if (await hasStored(name)) {
      // (a) a valid token already exists → genuine no-op reconnect.
      process.stderr.write(`xcg-proxy login: "${name}" token still valid; no re-authorization needed\n`);
      return;
    }

    // (b) no token, no 401 on initialize (e.g. Gmail defers it to tools/call).
    //     Decide by EXPLICIT discovery. discoverFn returns the metadata, returns
    //     undefined only for a real 404 (no metadata), and THROWS for network/5xx
    //     failures — those propagate and fail the login (never a false success).
    const metadata = await discoverFn(url);
    if (!metadata) {
      process.stderr.write(`xcg-proxy login: "${name}" — no authorization required by server\n`);
      return;
    }
    // Metadata present → drive auth() WITHOUT a catch: a real auth failure must
    // surface as a login error, never a false success.
    const result = await authFn(provider, { serverUrl: url, scope, fetchFn: refreshFetch });
    if (result === 'REDIRECT') {
      const code = await callback.waitForCode();
      await transport.finishAuth(code);
      recordIfAuthorized();
      process.stderr.write(`xcg-proxy login: authorized "${name}" (deferred auth); token stored in Keychain\n`);
    } else {
      process.stderr.write(`xcg-proxy login: authorized "${name}" via stored/refreshed credentials\n`);
    }
  } finally {
    callback.close();
    await transport.close().catch(() => {});
  }
}
