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
  | { event: 'invalidated'; scope: 'tokens' | 'all' }
  | { event: 'corrupt_blob'; scope: 'tokens' | 'client' }
  // Emitted by the refresh single-flight interceptor (refresh-fetch.ts):
  // 'refresh_coalesced' = another process already rotated the RT, so this
  // refresh was answered from the Keychain without touching the network;
  // 'lock_timeout' = the cross-process lock couldn't be acquired within the
  // timeout and the refresh proceeded UNLOCKED (fail-open — statu quo risk).
  | { event: 'refresh_coalesced' }
  // 'refresh_coalesced_stale' = another process had rotated, but the token it
  // left in the Keychain is past (or of unknown) expiry, so the coalesce was
  // upgraded to a REAL refresh against the token endpoint using the STORED
  // refresh token. Distinguishable in the trail from a plain coalesce.
  | { event: 'refresh_coalesced_stale' }
  | { event: 'lock_timeout'; waitedMs: number };

/** Tokens as persisted by xcg-proxy: the SDK's OAuthTokens plus our own
 *  `obtained_at` stamp. The SDK's OAuthTokensSchema is `$strip`
 *  (shared/auth.d.ts:145), so it drops the field on parse — only OUR writers
 *  (saveTokens here, and refresh-fetch's persist) ever set it. */
export type StoredTokens = OAuthTokens & { obtained_at?: number };

/** Refresh this long BEFORE nominal expiry, so a token cannot die in flight
 *  between our check and the server's. */
export const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Is the stored access token still safe to hand to a caller?
 *
 *  - no access_token                 → no (nothing to hand over);
 *  - no `expires_in`                 → yes: the server declared no lifetime, so
 *    we have no basis to call it stale, and forcing a refresh on every coalesce
 *    would defeat the cross-process single-flight the lock exists for;
 *  - `expires_in` but no obtained_at → no: a blob written before this stamp
 *    existed. Age unknown, so it must be refreshed for real (this is the 27/08
 *    Notion case: expires_in 28800 = 8 h, adopted ~14 h after it was minted);
 *  - both present                    → compare against now, minus the margin.
 */
export function accessTokenUsable(stored: StoredTokens | undefined, nowMs: number): boolean {
  if (stored?.access_token === undefined) return false;
  if (stored.expires_in === undefined) return true;
  if (typeof stored.obtained_at !== 'number') return false;
  return nowMs < stored.obtained_at + stored.expires_in * 1000 - ACCESS_TOKEN_EXPIRY_MARGIN_MS;
}

/** Keychain account holding a connector's OAuth tokens. Single source shared by
 *  the provider and the refresh single-flight interceptor (refresh-fetch.ts),
 *  which rereads/persists the same item inside its critical section. */
export function tokensAccount(mcp: string): string {
  return `${mcp}:tokens`;
}

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
  private tokensCache: { v: StoredTokens | undefined } | null = null;
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

  // Event entry point for collaborators outside the provider that participate
  // in the token lifecycle (the refresh single-flight interceptor): routes
  // through emitEvent so lastTokenEvent() covers these for oauth_failed triage.
  noteEvent(e: TokenEvent): void {
    this.emitEvent(e);
  }

  private acct(kind: 'tokens' | 'client' | 'verifier'): string {
    return kind === 'tokens' ? tokensAccount(this.mcp) : `${this.mcp}:${kind}`;
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
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as OAuthClientInformationFull;
    } catch {
      // Blob ilegible (p. ej. truncado, como pasó con Atlassian vía `security -i`)
      // = credencial ausente: el SDK re-registra el cliente / cae a reauth limpio
      // en vez de reventar dentro de auth(). El evento deja la corrupción en el
      // audit log en lugar de silenciarla.
      this.emitEvent({ event: 'corrupt_blob', scope: 'client' });
      return undefined;
    }
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await keychainSet(this.acct('client'), JSON.stringify(info));
  }

  async tokens(): Promise<StoredTokens | undefined> {
    if (this.tokensCache === null) {
      const raw = await keychainGet(this.acct('tokens'));
      let v: StoredTokens | undefined;
      if (raw != null) {
        try {
          v = JSON.parse(raw) as StoredTokens;
        } catch {
          // Blob ilegible = credencial ausente, y se cachea como tal: sin la caché
          // el parse relanzaría desde _commonHeaders en CADA request (bucle de
          // lectura + excepción) en vez de caer una sola vez a reauth limpio.
          this.emitEvent({ event: 'corrupt_blob', scope: 'tokens' });
        }
      }
      this.tokensCache = { v };
    }
    return this.tokensCache.v;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const prev = this.tokensCache?.v?.refresh_token;
    const stamped = await this.stampObtainedAt(tokens);
    await keychainSet(this.acct('tokens'), JSON.stringify(stamped));
    this.tokensCache = { v: stamped };
    this.lastTokensSaveAt = Date.now();
    this.emitEvent({ event: 'refreshed', rotated: prev !== undefined && prev !== tokens.refresh_token });
  }

  // saveTokens is the LAST writer on a refresh (refresh-fetch persists first,
  // then the SDK parses — dropping obtained_at, since OAuthTokensSchema is
  // $strip — and calls us), so the stamp has to be re-applied here or it never
  // survives. It must date THIS access token, not the moment of the write: a
  // coalesced refresh replays an older token unchanged, and stamping `now` on
  // it would hide exactly the staleness we are trying to catch. So: same
  // access_token as the stored blob → carry its stamp forward; anything else →
  // this is a freshly issued token, stamp now.
  private async stampObtainedAt(tokens: OAuthTokens): Promise<StoredTokens> {
    let carried: number | undefined;
    try {
      const raw = await keychainGet(this.acct('tokens'));
      if (raw != null) {
        const stored = JSON.parse(raw) as StoredTokens;
        if (stored.access_token === tokens.access_token && typeof stored.obtained_at === 'number') {
          carried = stored.obtained_at;
        }
      }
    } catch {
      // Absent or unreadable blob: nothing to carry, stamp fresh below.
    }
    return { ...tokens, obtained_at: carried ?? Date.now() };
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
          storedRt = raw == null ? undefined : (JSON.parse(raw) as StoredTokens).refresh_token;
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
