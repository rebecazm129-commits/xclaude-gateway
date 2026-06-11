import http from 'node:http';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { LoginOAuthProvider } from './oauth-provider.js';
import { hasStoredCredentials } from './credentials.js';

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
  authFn?: (provider: OAuthClientProvider, opts: { serverUrl: string; scope?: string }) => Promise<'AUTHORIZED' | 'REDIRECT'>;
  hasStored?: (name: string) => Promise<boolean>;
  discoverFn?: (url: string) => Promise<unknown>;
  createTransport?: (url: string, provider: LoginOAuthProvider) => LoginTransport;
  startCallback?: (provider: LoginOAuthProvider) => Promise<CallbackHandle>;
}

export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string }
  | { kind: 'ignore' };

export function interpretCallback(reqUrl: URL, callbackPath: string): CallbackResult {
  if (reqUrl.pathname !== callbackPath) return { kind: 'ignore' };
  const error = reqUrl.searchParams.get('error');
  if (error) return { kind: 'error', error };
  const code = reqUrl.searchParams.get('code');
  if (code) return { kind: 'code', code };
  return { kind: 'error', error: 'missing_code' };
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

function defaultCreateTransport(url: string, provider: LoginOAuthProvider): LoginTransport {
  return new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }) as unknown as LoginTransport;
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
    const result = interpretCallback(reqUrl, callbackPath);
    if (result.kind === 'ignore') {
      res.writeHead(404).end();
      return;
    }
    if (result.kind === 'error') {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(`<html><body>xCLAUDE login failed: ${result.error}. You can close this tab.</body></html>`);
      rejectCode(new Error(`authorization callback error: ${result.error}`));
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<html><body>xCLAUDE: login complete. You can close this tab.</body></html>');
    resolveCode(result.code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${port} is in use; close the conflicting process and retry`)
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

  const provider = new LoginOAuthProvider(name);
  const callback = await startCallback(provider);
  const transport = createTransport(url, provider);
  try {
    await transport.start();
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
    const result = await authFn(provider, { serverUrl: url, scope });
    if (result === 'REDIRECT') {
      const code = await callback.waitForCode();
      await transport.finishAuth(code);
      process.stderr.write(`xcg-proxy login: authorized "${name}" (deferred auth); token stored in Keychain\n`);
    } else {
      process.stderr.write(`xcg-proxy login: authorized "${name}" via stored/refreshed credentials\n`);
    }
  } finally {
    callback.close();
    await transport.close().catch(() => {});
  }
}
