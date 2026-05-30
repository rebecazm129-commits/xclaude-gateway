import { spawn } from 'node:child_process';

import { keychainGet, keychainSet, keychainDelete } from './keychain.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export class ReauthRequiredError extends Error {
  constructor(public readonly mcp: string) {
    super(`interactive login required for "${mcp}" — run the xCLAUDE login flow`);
    this.name = 'ReauthRequiredError';
  }
}

export class KeychainOAuthProvider implements OAuthClientProvider {
  private static readonly REDIRECT_URI = 'http://127.0.0.1:51703/xcg-callback';

  // Caché en memoria del token: streamableHttp._commonHeaders llama a tokens()
  // en CADA request, así que sin caché habría un spawn de /usr/bin/security por
  // frame. null = aún no cargado; { v: undefined } = cargado y ausente. La caché
  // se invalida en saveTokens y en invalidateCredentials('all'|'tokens').
  // clientInformation y codeVerifier NO se cachean: solo se leen durante auth(),
  // no por-request, así que el spawn ocasional es aceptable.
  private tokensCache: { v: OAuthTokens | undefined } | null = null;

  constructor(private readonly mcp: string) {}

  private acct(kind: 'tokens' | 'client' | 'verifier'): string {
    return `${this.mcp}:${kind}`;
  }

  get redirectUrl(): string {
    return KeychainOAuthProvider.REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [KeychainOAuthProvider.REDIRECT_URI],
      client_name: 'xCLAUDE Gateway',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const raw = await keychainGet(this.acct('client'));
    return raw == null ? undefined : (JSON.parse(raw) as OAuthClientInformationFull);
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await keychainSet(this.acct('client'), JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.tokensCache === null) {
      const raw = await keychainGet(this.acct('tokens'));
      this.tokensCache = { v: raw == null ? undefined : (JSON.parse(raw) as OAuthTokens) };
    }
    return this.tokensCache.v;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await keychainSet(this.acct('tokens'), JSON.stringify(tokens));
    this.tokensCache = { v: tokens };
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await keychainSet(this.acct('verifier'), verifier);
  }

  async codeVerifier(): Promise<string> {
    const raw = await keychainGet(this.acct('verifier'));
    if (raw == null) throw new Error(`no PKCE code verifier stored for "${this.mcp}"`);
    return raw;
  }

  redirectToAuthorization(_authorizationUrl: URL): void {
    throw new ReauthRequiredError(this.mcp);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      await keychainDelete(this.acct('tokens'));
      this.tokensCache = { v: undefined };
    }
    if (scope === 'all' || scope === 'client') await keychainDelete(this.acct('client'));
    if (scope === 'all' || scope === 'verifier') await keychainDelete(this.acct('verifier'));
  }
}

// Provider para el login interactivo: abre el navegador en vez de rechazar. El
// listener loopback (login.ts) captura el callback. Hereda redirectUrl/clientMetadata
// (el placeholder 51703 ES la URI de loopback real) y todo el almacenamiento Keychain.
export class LoginOAuthProvider extends KeychainOAuthProvider {
  redirectToAuthorization(authorizationUrl: URL): void {
    spawn('/usr/bin/open', [authorizationUrl.toString()], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  }
}
