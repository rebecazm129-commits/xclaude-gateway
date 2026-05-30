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
    // start() crea el AbortController pero es no-op de auth en este SDK; quien
    // dispara el 401 -> discovery -> DCR -> redirectToAuthorization es el primer
    // send(). Mandamos un initialize: el provider abrirá el navegador / imprimirá
    // la URL y luego el SDK lanza el UnauthorizedError esperado (REDIRECT).
    try {
      await transport.start();
      await transport.send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'xcg-proxy-login', version: '0.0.0' },
        },
      });
    } catch (err) {
      // Tras abrir el navegador, el SDK lanza UnauthorizedError (REDIRECT): esperado.
      // Cualquier otra cosa (fallo de discovery/DCR) es un error real.
      if (!(err instanceof UnauthorizedError)) throw err;
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
