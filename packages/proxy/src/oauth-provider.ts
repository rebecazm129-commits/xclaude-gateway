import { spawn } from 'node:child_process';

import { keychainGet, keychainSet, keychainDelete } from './keychain.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export const RECENT_REFRESH_MS = 10_000;

export type TokenEvent =
  | { event: 'refreshed'; rotated: boolean }
  | { event: 'race_recovered'; crossProcess?: boolean }
  | { event: 'invalidated'; scope: 'tokens' | 'all' };

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
  private lastTokensSaveAt = 0;
  // Último TokenEvent emitido y cuándo. El error real del token endpoint muere
  // dentro del SDK (auth() lo convierte en invalidateCredentials o lo traga y
  // cae al flujo interactivo → ReauthRequiredError genérico), así que el evento
  // inmediatamente anterior es la única señal que queda para distinguir en el
  // JSONL "invalid_grant en el refresh" (invalidated) de "401 con token recién
  // refrescado" (refreshed). main.ts lo adjunta al proxy.error oauth_failed.
  private lastEmitted: { event: TokenEvent['event']; atMs: number } | null = null;

  constructor(
    private readonly mcp: string,
    private readonly onEvent?: (e: TokenEvent) => void,
  ) {}

  private emitEvent(e: TokenEvent): void {
    this.lastEmitted = { event: e.event, atMs: Date.now() };
    this.onEvent?.(e);
  }

  lastTokenEvent(): { event: TokenEvent['event']; agoMs: number } | null {
    if (this.lastEmitted === null) return null;
    return { event: this.lastEmitted.event, agoMs: Date.now() - this.lastEmitted.atMs };
  }

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
    const prev = this.tokensCache?.v?.refresh_token;
    await keychainSet(this.acct('tokens'), JSON.stringify(tokens));
    this.tokensCache = { v: tokens };
    this.lastTokensSaveAt = Date.now();
    this.emitEvent({ event: 'refreshed', rotated: prev !== undefined && prev !== tokens.refresh_token });
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
    if (scope === 'tokens' && Date.now() - this.lastTokensSaveAt < RECENT_REFRESH_MS) {
      // Notion rota refresh tokens: en una ráfaga concurrente al expirar, un refresh
      // "perdedor" recibe invalid_grant aunque otro acabe de refrescar con éxito.
      // Si hubo saveTokens reciente, NO borramos el token compartido; reseteamos la
      // caché para que el reintento del SDK relee el token fresco y se autorice.
      this.tokensCache = null;
      this.emitEvent({ event: 'race_recovered' });
      return;
    }
    if (scope === 'tokens') {
      // Guarda cross-proceso: Claude Desktop mantiene varios xcg-proxy del mismo
      // conector vivos a la vez (restarts solapados), cada uno con su tokensCache.
      // Notion rota el refresh token en cada refresh, así que un proceso longevo
      // refresca con un RT ya rotado por otro proceso → invalid_grant → el SDK
      // ordena invalidar; borrar aquí destruiría el token FRESCO que el otro
      // proceso acaba de escribir y fuerza re-login interactivo. tokensCache.v
      // contiene fiablemente el RT que falló: el SDK llama a tokens() justo antes
      // de refrescar, y el único modo de que la caché haya sido pisada después es
      // un saveTokens propio reciente — el fast-path de RECENT_REFRESH_MS de
      // arriba ya cubre ese caso. Si el RT del Keychain difiere del fallido, otro
      // proceso rotó: soltamos la caché (el reintento del SDK relee el token
      // fresco) y conservamos el Keychain. Sin tokens en Keychain, RT idéntico,
      // caché vacía o blob ilegible → sin evidencia de carrera: borrado normal.
      const failedRt = this.tokensCache?.v?.refresh_token;
      if (failedRt !== undefined) {
        let storedRt: string | undefined;
        try {
          const raw = await keychainGet(this.acct('tokens'));
          storedRt = raw == null ? undefined : (JSON.parse(raw) as OAuthTokens).refresh_token;
        } catch {
          storedRt = undefined;
        }
        if (storedRt !== undefined && storedRt !== failedRt) {
          this.tokensCache = null;
          this.emitEvent({ event: 'race_recovered', crossProcess: true });
          return;
        }
      }
    }
    if (scope === 'all' || scope === 'tokens') {
      await keychainDelete(this.acct('tokens'));
      this.tokensCache = { v: undefined };
      this.emitEvent({ event: 'invalidated', scope });
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
    process.stderr.write(
      `\nxcg-proxy login: open this URL in your browser to authorize:\n\n  ${authorizationUrl.toString()}\n\n`,
    );
    spawn('/usr/bin/open', [authorizationUrl.toString()], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  }
}
