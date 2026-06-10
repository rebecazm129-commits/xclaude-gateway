import http from 'node:http';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { LoginOAuthProvider } from './oauth-provider.js';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginArgs {
  url: string;
  name: string;
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

export async function runLogin({ url, name }: LoginArgs): Promise<void> {
  const provider = new LoginOAuthProvider(name);
  const redirect = new URL(provider.redirectUrl);
  const port = Number(redirect.port);
  const callbackPath = redirect.pathname;

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
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is in use; close the conflicting process and retry`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  let timer: NodeJS.Timeout | undefined;
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

    if (!redirected) {
      // Token still valid — reconnect is a no-op. No browser, no callback wait.
      // This is the reconnect-of-an-authorized-connector path that previously
      // hung for the full 5-min timeout (it waited for a callback that the
      // never-opened browser could not produce).
      process.stderr.write(`xcg-proxy login: "${name}" token still valid; no re-authorization needed\n`);
      return;
    }

    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error('timed out waiting for the browser authorization callback')),
          CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);

    await transport.finishAuth(code);
    process.stderr.write(`xcg-proxy login: authorized "${name}"; token stored in Keychain\n`);
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    await transport.close().catch(() => {});
  }
}
