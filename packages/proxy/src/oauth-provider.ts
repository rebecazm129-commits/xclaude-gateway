import { spawn } from 'node:child_process';

import { keychainGet, keychainSet, keychainDelete } from './keychain.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationCapture } from './oauth-authorized.js';
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
  | { event: 'lock_timeout'; waitedMs: number }
  // 'metadata_issuer_mismatch' = the authorization server metadata's `issuer`
  // is not the URL it was discovered at (RFC 8414 §3.3). Recorded once per
  // process by the wrappers, which do not block on it; the login refuses.
  // Carries no value: which server it was is in the connector's config.
  | { event: 'metadata_issuer_mismatch' }
  // 'refresh_rejected' = the token endpoint answered non-2xx to a refresh.
  // This is the ONLY place the server's real reason survives: the SDK turns it
  // into parseErrorResponse → InvalidGrantError → invalidateCredentials, and by
  // the time we see 'invalidated' the body is gone (see the lastEmitted note
  // below). status is always present; the OAuth fields only when the body was
  // JSON. oauthErrorDescription is redacted and truncated by the emitter.
  | {
      event: 'refresh_rejected';
      status: number;
      oauthError?: string;
      oauthErrorDescription?: string;
    };

/** Tokens as persisted by xcg-proxy: the SDK's OAuthTokens plus our own
 *  `obtained_at` stamp. The SDK's OAuthTokensSchema is `$strip`
 *  (shared/auth.d.ts:145), so it drops the field on parse — only OUR writers
 *  (saveTokens here, and refresh-fetch's persist) ever set it.
 *
 *  `issuer` (SDK ≥ 1.31, SEP-2352): the authorization server the set belongs
 *  to, stamped by the SDK's auth() on every saveTokens / saveClientInformation.
 *  Both are stored as given and returned as stored, which is all the SDK needs
 *  to treat a set bound to another server as absent (re-register, re-authorize,
 *  never refresh). */
export type StoredTokens = OAuthTokens & { obtained_at?: number; issuer?: string };

/**
 * Two authorization server identifiers name the same server: compared as
 * parsed URLs (scheme, host, default port), tolerating one trailing `/` — the
 * SDK's own rule (issuersMatch in client/auth.js), so refresh-fetch never
 * disagrees with auth() about which set belongs where.
 */
export function issuersMatch(a: string, b: string): boolean {
  let [x, y] = [a, b];
  try {
    [x, y] = [new URL(a).href, new URL(b).href];
  } catch {
    // Not two URLs: compared as written.
  }
  return x === y || (x.endsWith('/') && x.slice(0, -1) === y) || (y.endsWith('/') && y.slice(0, -1) === x);
}

/**
 * RFC 8414 §3.3: the metadata's `issuer` must be IDENTICAL to the
 * authorization server URL it was discovered at — both as raw text, never
 * through new URL(). One concession: when the URL has no path beyond the
 * authority ("https://host" or "https://host/"), with and without the final
 * slash count as the same, because that is how a real server publishes both
 * (Google: "https://accounts.google.com/" advertised, "https://accounts.google.com"
 * as issuer). Case, ports, percent-encoding and slashes in a non-empty path
 * are never normalized.
 */
export function metadataIssuerMatches(issuer: string, authorizationServerUrl: string): boolean {
  if (issuer === authorizationServerUrl) return true;
  const ROOT = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/;
  if (!ROOT.test(issuer) || !ROOT.test(authorizationServerUrl)) return false;
  const bare = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);
  return bare(issuer) === bare(authorizationServerUrl);
}

/** Why the login refuses an authorization server, said the same way every
 *  time: no value from the server reaches the message. */
export const METADATA_ISSUER_MISMATCH_MESSAGE =
  'the authorization server metadata does not identify the server it was fetched from (RFC 8414)';

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
  // The authorization server auth() discovered in THIS process, in its current
  // run: String(authorizationServerUrl), the exact value the SDK binds stored
  // credentials to. In memory only, set by the SDK through saveDiscoveryState
  // before any refresh. It is the ONLY source of the expected issuer for
  // refresh-fetch: never the Keychain, never a token response.
  private discoveredIssuer: string | null = null;
  // metadata_issuer_mismatch is recorded once per process, not on every auth().
  private issuerMismatchNoted = false;

  constructor(
    protected readonly mcp: string,
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

  // Only the save half: without discoveryState() the SDK keeps rediscovering on
  // every auth(), exactly as before. Called by auth() in every run, before it
  // reads the stored client and tokens and before any refresh.
  //
  // Also checks RFC 8414 §3.3 on the raw metadata: here only RECORDED (a
  // wrapper that refuses would take a working connector down mid-session);
  // the login provider below refuses.
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveredIssuer = String(state.authorizationServerUrl);
    if (!this.discoveredIssuerIsConsistent(state) && !this.issuerMismatchNoted) {
      this.issuerMismatchNoted = true;
      this.emitEvent({ event: 'metadata_issuer_mismatch' });
    }
  }

  /** RFC 8414 §3.3 on what discovery returned. No metadata document (the SDK
   *  then falls back to default endpoints) has no issuer to contradict. */
  protected discoveredIssuerIsConsistent(state: OAuthDiscoveryState): boolean {
    const issuer = state.authorizationServerMetadata?.issuer;
    return typeof issuer !== 'string' || metadataIssuerMatches(issuer, String(state.authorizationServerUrl));
  }

  /** The authorization server of this process's current auth() run, or null
   *  when none has run yet. */
  currentIssuer(): string | null {
    return this.discoveredIssuer;
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

  // Early guard. The wrapper is a NON-INTERACTIVE OAuth consumer: it can use a
  // token or refresh one, never start an authorization. discoveryState() is the
  // first thing the SDK's auth() asks the provider — before discovery, client
  // registration, PKCE or any Keychain write — so with neither a usable access
  // token nor a refresh token the wrapper stops here. Returning undefined keeps
  // today's behavior otherwise (no cached discovery: auth() rediscovers).
  // The 08/10 stripe incident: five wrappers started without a token during a
  // Reconnect, each ran auth() to the end and overwrote the login's verifier.
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const stored = await this.tokens();
    if (stored?.refresh_token === undefined && !accessTokenUsable(stored, Date.now())) {
      throw new ReauthRequiredError(this.mcp);
    }
    return undefined;
  }

  // Invariant: the wrapper never creates or overwrites :client; it only deletes
  // it if the server rejects it (invalid_client / unauthorized_client, via the
  // SDK's invalidateCredentials('all')). Only the login registers (DCR) and
  // persists a client. No stored client, or
  // one bound to another authorization server, would make the SDK register a
  // new one — the wrapper refuses instead (saveDiscoveryState runs before this
  // in every auth(), so the discovered issuer is known here).
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const stored = await this.readStoredClient();
    if (stored === undefined) throw new ReauthRequiredError(this.mcp);
    const bound = (stored as { issuer?: unknown }).issuer;
    if (typeof bound === 'string' && this.discoveredIssuer !== null && !issuersMatch(bound, this.discoveredIssuer)) {
      throw new ReauthRequiredError(this.mcp);
    }
    return stored;
  }

  protected async readStoredClient(): Promise<OAuthClientInformationFull | undefined> {
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

  // Never called with the guards above: clientInformation() refuses before the
  // SDK would register. The one remaining call is the SDK stamping an unbound
  // client with its issuer after a refresh (bindClientInformation), which it
  // wraps in try/catch — the client then stays unbound and is used as stored.
  async saveClientInformation(_info: OAuthClientInformationFull): Promise<void> {
    throw new ReauthRequiredError(this.mcp);
  }

  protected async writeClient(info: OAuthClientInformationFull): Promise<void> {
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

  // The wrapper never stores a PKCE verifier: it cannot complete an
  // authorization, and a verifier written here would overwrite the one a login
  // in progress depends on. The login keeps its own in memory (below).
  async saveCodeVerifier(_verifier: string): Promise<void> {
    throw new ReauthRequiredError(this.mcp);
  }

  async codeVerifier(): Promise<string> {
    throw new ReauthRequiredError(this.mcp);
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
    // The verifier no longer lives in the Keychain (the login keeps it in
    // memory), so no scope deletes it here.
    if (scope === 'all' || scope === 'client') await keychainDelete(this.acct('client'));
  }
}

// Provider para el login interactivo: abre el navegador en vez de rechazar. El
// listener loopback (login.ts) captura el callback. Hereda redirectUrl/clientMetadata
// (el placeholder 51703 ES la URI de loopback real) y el almacenamiento Keychain de
// los tokens; el verifier, el cliente nuevo y los tokens del canje viven en memoria
// hasta persistAuthorization().
//
// It also captures what proxy.oauth_authorized records (oauth-authorized.ts), in
// memory and reduced on the spot: two query parameters of the authorization
// URL (the URL itself is dropped), the authorization server the SDK chose, and
// whether the token response carried a scope. authorizationCapture() is
// non-null only once a code was exchanged: a redirect happened AND tokens were
// saved after it. A refresh with no redirect never qualifies.
export class LoginOAuthProvider extends KeychainOAuthProvider {
  private redirected: { requestedScopes: string[]; resource: string | null } | null = null;
  private authorizationServer: Pick<AuthorizationCapture, 'authorizationServer' | 'authorizationServerSource'> | null =
    null;
  private exchanged: { grantedScopes: string[] | null } | null = null;
  // RFC 9207: what the callback's `iss` is checked against — the metadata's
  // `issuer` as published (raw), and whether the server promised to send it.
  private responseIss: { issuer: string | null; required: boolean } | null = null;
  // PKCE verifier of THIS login, in memory only: no other process can overwrite
  // it between the redirect and the code exchange.
  private verifier: string | null = null;
  // A client registered (DCR) or stamped in this login, and the tokens of the
  // code exchange: held here and written to the Keychain only by
  // persistAuthorization(), after finishAuth succeeded. The stored client is
  // read once and kept, so a wrapper deleting it mid-login cannot pull it from
  // under the exchange.
  private pendingClient: OAuthClientInformationFull | null = null;
  private storedClient: { v: OAuthClientInformationFull | undefined } | null = null;
  private pendingTokens: OAuthTokens | null = null;

  // The login IS the interactive flow: no early guard, full discovery as before.
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return undefined;
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    if (this.pendingClient !== null) return this.pendingClient;
    if (this.storedClient === null) this.storedClient = { v: await this.readStoredClient() };
    return this.storedClient.v;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.pendingClient = info;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.verifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (this.verifier === null) throw new Error(`no PKCE code verifier in this login for "${this.mcp}"`);
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') {
      this.pendingClient = null;
      this.storedClient = null;
    }
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
    if (scope === 'all' || scope === 'tokens') this.pendingTokens = null;
    await super.invalidateCredentials(scope);
  }

  /** Writes what the code exchange produced: the client first, then the tokens
   *  bound to it. Called by runLogin only after finishAuth succeeded. */
  async persistAuthorization(): Promise<void> {
    if (this.pendingClient !== null) {
      await this.writeClient(this.pendingClient);
      this.storedClient = { v: this.pendingClient };
      this.pendingClient = null;
    }
    if (this.pendingTokens !== null) {
      const tokens = this.pendingTokens;
      this.pendingTokens = null;
      await super.saveTokens(tokens);
    }
  }

  // Keeps the base's issuer record, then REFUSES a metadata document that
  // does not identify its own server (RFC 8414 §3.3): auth() awaits this, so
  // the throw ends the login before any registration or redirect. Then
  // captures for oauth_authorized and for the iss check.
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    super.saveDiscoveryState(state);
    if (!this.discoveredIssuerIsConsistent(state)) throw new Error(METADATA_ISSUER_MISMATCH_MESSAGE);
    const md = state.authorizationServerMetadata;
    this.responseIss = {
      issuer: typeof md?.issuer === 'string' ? md.issuer : null,
      required: (md as Record<string, unknown> | undefined)?.['authorization_response_iss_parameter_supported'] === true,
    };
    const chosen = String(state.authorizationServerUrl);
    this.authorizationServer = {
      authorizationServer: chosen,
      authorizationServerSource:
        state.resourceMetadata?.authorization_servers?.[0] === chosen ? 'protected_resource_metadata' : 'server_url_fallback',
    };
  }

  // A code exchange (a redirect happened in this login) is held for
  // persistAuthorization(). A refresh on the stored-credentials path, with no
  // redirect, is written as before.
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (this.redirected === null) {
      await super.saveTokens(tokens);
      return;
    }
    this.pendingTokens = tokens;
    this.exchanged = { grantedScopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : null };
  }

  /**
   * RFC 9207 / SEP-2468, on the authorization response BEFORE its code is
   * exchanged. `iss` is compared EXACTLY with the metadata's `issuer`:
   *   present and different                    → 'mismatch'
   *   absent, metadata promised it (…_supported: true) → 'missing'
   *   absent, not promised                     → 'ok'
   * Present with no known issuer (no metadata document) cannot be verified,
   * so it is a mismatch too.
   */
  checkResponseIss(iss: string | undefined): 'ok' | 'mismatch' | 'missing' {
    if (iss !== undefined) {
      return this.responseIss?.issuer !== null && this.responseIss?.issuer === iss ? 'ok' : 'mismatch';
    }
    return this.responseIss?.required === true ? 'missing' : 'ok';
  }

  authorizationCapture(): AuthorizationCapture | null {
    if (this.redirected === null || this.exchanged === null || this.authorizationServer === null) return null;
    return { ...this.authorizationServer, ...this.redirected, grantedScopes: this.exchanged.grantedScopes };
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const scope = authorizationUrl.searchParams.get('scope');
    this.redirected = {
      requestedScopes: scope === null ? [] : scope.split(/\s+/).filter(Boolean),
      resource: authorizationUrl.searchParams.get('resource'),
    };
    process.stderr.write(
      `\nxcg-proxy login: open this URL in your browser to authorize:\n\n  ${authorizationUrl.toString()}\n\n`,
    );
    spawn('/usr/bin/open', [authorizationUrl.toString()], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  }
}
