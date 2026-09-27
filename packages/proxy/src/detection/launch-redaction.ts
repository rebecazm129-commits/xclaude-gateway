// Launch-argument redaction: what proxy.started records about the command line
// of the wrapped server, and what proxy.http_started records about the remote
// URL. A launch spec carries secrets in a handful of well-known places — an
// --api-key flag, an Authorization header, a TOKEN=… assignment, a URL's
// userinfo or its ?token= — and only there, or where a value has the shape of
// a known credential format, does anything get replaced.
//
// Evidence only: no entropy rules. A UUID, a commit sha, a project id or a
// path passes untouched unless a flag or a variable NAME says it is a secret.
//
// The replacement is masking.ts's own mask — same format, same fingerprint,
// same per-install salt — so a secret redacted here has the same fp as the
// same secret masked out of a tool call. Its type says WHERE the evidence came
// from, unless the value is itself a whole known credential, in which case the
// credential format wins (an --api-key holding sk-ant-… is anthropic_api_key).

import { credentialMatches } from './detectors/credential.js';
import { isCredentialName, tokenizeParamName } from './detectors/sensitive-params.js';
import { maskValue } from './masking.js';

/** Where the evidence for a structural mask came from. */
export type LaunchSecretType =
  | 'cli_secret' // value of a flag whose name carries a credential (--api-key)
  | 'header_secret' // value of a credential header (Authorization, Cookie…)
  | 'env_secret' // value of NAME=value where NAME carries a credential
  | 'url_userinfo' // user or password in scheme://user:pass@host
  | 'url_query_secret'; // value of a credential query parameter (?token=)

// A credential-looking name whose LAST token says the value is not the secret
// itself but where to find it, what kind it is, or a switch: --token-file
// /path, --auth-url https://…, GITHUB_TOKEN_ENV=VAR, --password-stdin,
// --secret-id arn:…. Those values still go through the URL and format rules.
const NON_SECRET_QUALIFIERS: ReadonlySet<string> = new Set([
  'file', 'path', 'dir', 'url', 'uri', 'endpoint', 'host', 'server', 'port',
  'type', 'mode', 'method', 'provider', 'scheme', 'kind', 'format',
  'env', 'var', 'name', 'id', 'stdin', 'cmd', 'command', 'helper', 'store',
]);

/** A NAME (flag without dashes, env var, header-less assignment) whose value is
 *  a secret: a credential name, not a `no-` switch, not a qualifier. */
export function isSecretName(name: string): boolean {
  const t = tokenizeParamName(name);
  if (t.length === 0 || t[0] === 'no') return false;
  if (NON_SECRET_QUALIFIERS.has(t[t.length - 1]!)) return false;
  return isCredentialName(name);
}

// Headers whose VALUE is a credential. Everything else (Content-Type, Accept,
// User-Agent, X-Request-Id…) is kept; an unknown header's value still goes
// through the format rules.
const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
]);

// Query parameters whose value is a credential, compared after normalising the
// name (lowercase, camelCase → snake_case, `-` → `_`). A name that ENDS in one
// of these after `_` also counts (id_token, refresh_token, x_amz_signature,
// x_amz_credential) — except `key`, whose suffix form is mostly not a secret
// (sort_key, idempotency_key, primary_key).
const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password',
  'signature', 'sig', 'credential', 'auth',
]);
const SECRET_QUERY_SUFFIXES: readonly string[] = [...SECRET_QUERY_PARAMS]
  .filter((p) => p !== 'key' && p !== 'apikey')
  .map((p) => `_${p}`);

function normalizeQueryName(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // Malformed escape: compare the raw text.
  }
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/-/g, '_');
}

export function isSecretQueryParam(raw: string): boolean {
  const name = normalizeQueryName(raw);
  return SECRET_QUERY_PARAMS.has(name) || SECRET_QUERY_SUFFIXES.some((s) => name.endsWith(s));
}

// Header flags: -H (curl, mcp-remote), and any long flag whose last token is
// header/headers (--header, --headers, --http-header, --extra-header…).
function isHeaderFlag(flag: string): boolean {
  if (flag === '-H') return true;
  if (!flag.startsWith('--')) return false;
  const t = tokenizeParamName(flag);
  const last = t[t.length - 1];
  return last === 'header' || last === 'headers';
}

const ENV_FLAGS: ReadonlySet<string> = new Set(['-e', '--env']);

// NAME=value with a variable-like NAME (FOO_TOKEN=…, figmaApiKey=…).
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/;

// scheme://rest, stopping at whitespace and the quotes/brackets that commonly
// wrap a URL inside a larger argument (JSON, a header value).
const URL_IN_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g;

export class LaunchRedactor {
  constructor(private readonly hmacKey: Buffer) {}

  /** Mask a value located by structure. If the whole value is one known
   *  credential, its format names the mask; otherwise the structural type. */
  private mask(value: string, type: LaunchSecretType): string {
    const m = credentialMatches(value);
    const t = m.length === 1 && m[0]!.value === value ? m[0]!.type : type;
    return maskValue(this.hmacKey, value, t);
  }

  /** Mask every known credential format inside free text. Longest first, so a
   *  value contained in another is never left half-replaced. */
  private maskFormats(text: string): string {
    const matches = [...credentialMatches(text)].sort((a, b) => b.value.length - a.value.length);
    let out = text;
    for (const { value, type } of matches) {
      out = out.split(value).join(maskValue(this.hmacKey, value, type));
    }
    return out;
  }

  /** userinfo and credential query values of one URL, in place: nothing else
   *  about the URL is rewritten. */
  private redactUrlSecrets(url: string): string {
    const schemeEnd = url.indexOf('://') + 3;
    const rest = url.slice(schemeEnd);
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

    let redactedAuthority = authority;
    const at = authority.lastIndexOf('@');
    if (at !== -1) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(':');
      const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
      const pass = colon === -1 ? undefined : userinfo.slice(colon + 1);
      const parts = [user.length > 0 ? this.mask(user, 'url_userinfo') : ''];
      if (pass !== undefined) parts.push(pass.length > 0 ? this.mask(pass, 'url_userinfo') : '');
      redactedAuthority = `${parts.join(':')}@${authority.slice(at + 1)}`;
    }

    return `${url.slice(0, schemeEnd)}${redactedAuthority}${this.redactQuery(tail)}`;
  }

  /** Mask the values of credential query parameters in `path?query#frag`. */
  private redactQuery(tail: string): string {
    const q = tail.indexOf('?');
    if (q === -1) return tail;
    const hash = tail.indexOf('#', q);
    const query = hash === -1 ? tail.slice(q + 1) : tail.slice(q + 1, hash);
    const after = hash === -1 ? '' : tail.slice(hash);
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        return value.length > 0 && isSecretQueryParam(name)
          ? `${name}=${this.mask(value, 'url_query_secret')}`
          : pair;
      })
      .join('&');
    return `${tail.slice(0, q + 1)}${redacted}${after}`;
  }

  /** Free text: URL secrets first, then any known credential format. */
  redactText(text: string): string {
    return this.maskFormats(text.replace(URL_IN_TEXT, (url) => this.redactUrlSecrets(url)));
  }

  /** `Name: value` (or `Name=value`) passed to a header flag. */
  private redactHeader(header: string): string {
    const m = /^([A-Za-z0-9-]+)(\s*[:=]\s*)([\s\S]*)$/.exec(header);
    if (m === null) return this.redactText(header); // JSON blob or other shape
    const [, name, sep, value] = m as unknown as [string, string, string, string];
    const lower = name.toLowerCase();
    if (!SECRET_HEADERS.has(lower) || value.length === 0) return `${name}${sep}${this.redactText(value)}`;
    // Keep the auth scheme (Bearer, Basic, token…): it says how, not what.
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      const scheme = /^([A-Za-z][A-Za-z0-9._-]*)(\s+)(\S[\s\S]*)$/.exec(value);
      if (scheme !== null) {
        return `${name}${sep}${scheme[1]}${scheme[2]}${this.mask(scheme[3]!, 'header_secret')}`;
      }
    }
    return `${name}${sep}${this.mask(value, 'header_secret')}`;
  }

  /** `NAME=value` as a bare argument or after -e/--env. */
  private redactAssignment(arg: string): string {
    const m = ASSIGNMENT.exec(arg);
    if (m === null) return this.redactText(arg);
    const [, name, value] = m as unknown as [string, string, string];
    if (value.length > 0 && isSecretName(name)) return `${name}=${this.mask(value, 'env_secret')}`;
    return `${name}=${this.redactText(value)}`;
  }

  /** The wrapped server's argv, one output per input, same order. */
  redactArgs(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      if (arg.startsWith('-') && arg !== '-' && arg !== '--') {
        const eq = arg.indexOf('=');
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        const inline = eq === -1 ? undefined : arg.slice(eq + 1);
        const next = args[i + 1];
        // A following argument is this flag's value only if it is not itself
        // a flag.
        const hasNext = inline === undefined && next !== undefined && !next.startsWith('-');

        if (isHeaderFlag(flag)) {
          if (inline !== undefined) out.push(`${flag}=${this.redactHeader(inline)}`);
          else {
            out.push(arg);
            if (hasNext) out.push(this.redactHeader(args[++i]!));
          }
          continue;
        }
        if (ENV_FLAGS.has(flag)) {
          if (inline !== undefined) out.push(`${flag}=${this.redactAssignment(inline)}`);
          else {
            out.push(arg);
            if (hasNext) out.push(this.redactAssignment(args[++i]!));
          }
          continue;
        }
        if (isSecretName(flag)) {
          if (inline !== undefined) {
            out.push(inline.length > 0 ? `${flag}=${this.mask(inline, 'cli_secret')}` : arg);
          } else {
            out.push(arg);
            if (hasNext) out.push(this.mask(args[++i]!, 'cli_secret'));
          }
          continue;
        }
        out.push(inline === undefined ? this.redactText(arg) : `${flag}=${this.redactText(inline)}`);
        continue;
      }

      out.push(ASSIGNMENT.test(arg) ? this.redactAssignment(arg) : this.redactText(arg));
    }
    return out;
  }

  /** The remote URL of an http wrapper, canonical and redacted: scheme and host
   *  lowercase, default port dropped, no userinfo, no fragment, credential
   *  query values masked. An unparseable URL falls back to redactText without
   *  its fragment — runHttp would fail on it anyway. */
  canonicalUrl(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      const hash = raw.indexOf('#');
      return this.redactText(hash === -1 ? raw : raw.slice(0, hash));
    }
    // WHATWG URL already lowercases scheme and host and drops the default
    // port; `search` keeps the query as written, so only the credential values
    // change.
    const base = `${u.protocol}//${u.host}${u.pathname}`;
    return this.maskFormats(`${base}${this.redactQuery(u.search)}`);
  }
}

export function redactLaunchArgs(args: readonly string[], hmacKey: Buffer): string[] {
  return new LaunchRedactor(hmacKey).redactArgs(args);
}

export function canonicalizeUrl(url: string, hmacKey: Buffer): string {
  return new LaunchRedactor(hmacKey).canonicalUrl(url);
}
