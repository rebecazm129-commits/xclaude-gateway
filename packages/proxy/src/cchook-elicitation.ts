// What the trail keeps of a Claude Code MCP elicitation — a strict whitelist.
//
// Elicitation: an MCP server asking the user for input mid-task. The hook
// payload carries the server, the mode, the server's message and the full
// requested_schema (defaults, enums, oneOf… included); in url mode, the URL.
// ElicitationResult carries the user's action and, on accept, what the user
// typed (the hook strips that before the spool; nothing here reads it).
//
// KEPT for an Elicitation: server, mode, elicitation_id (when there is one),
// the message (credential shapes masked downstream, truncated), and per
// requested field ONLY its name, type, title, format and whether it is
// required. NEVER default, enum, enumNames, oneOf, const, pattern or
// description: those are values or prose the server chose, and a default can
// be something of the user's. In url mode: scheme, host, port, path and the
// query with credential-named values replaced, plus flags — the userinfo and the
// fragment are never kept, only whether they were there.
//
// Field names and titles ARE read in memory, once, to decide whether the form
// asks for a secret (password, token, API key…) — that raises the severity.
// The description is never read for it: it is the server's prose, and prose
// that warns ("do not give us your pin") reads like prose that asks. A secret
// named only there stays at the request's own severity.

import type { CredentialMatch } from './detection/detectors/credential.js';
import { credentialMatches } from './detection/detectors/credential.js';
import { tokenizeParamName } from './detection/detectors/sensitive-params.js';
import { isSecretQueryParam } from './detection/launch-redaction.js';

export const ELICITATION_MESSAGE_MAX = 500;
export const ELICITATION_TITLE_MAX = 120;
export const ELICITATION_MAX_FIELDS = 50;

export interface ElicitationField {
  name: string;
  type?: string;
  title?: string;
  format?: string;
  required: boolean;
}

export interface ElicitationUrl {
  scheme?: string;
  host?: string;
  port?: string;
  path?: string;
  query?: string;
  had_userinfo?: boolean;
  had_fragment?: boolean;
  non_https?: boolean;
  punycode_host?: boolean;
  unparseable?: true;
}

export interface ElicitationSummary {
  mcp_server_name?: string;
  mode?: string;
  elicitation_id?: string;
  message?: string;
  message_truncated?: true;
  fields?: ElicitationField[];
  fields_truncated?: true;
  url?: ElicitationUrl;
}

export interface ElicitationReading {
  summary: ElicitationSummary;
  /** A form field looks like it asks for a secret (decided in memory). */
  asksForSecret: boolean;
  /** Values the ingester must mask before writing: credential shapes in the
   *  message or the URL (the hook masked them already; this covers a spool
   *  file written before it did). */
  maskSecrets: CredentialMatch[];
}

/** What a credential-named query value is replaced with. */
export const QUERY_MASK = '[masked]';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

// Words that name a secret, matched as whole tokens of a field's name or
// title (camelCase, snake_case and spaces all split).
const SECRET_TOKENS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'passphrase', 'passcode', 'secret', 'token', 'apikey',
  'credential', 'credentials', 'pin', 'otp', 'totp', 'mfa',
]);
const SECRET_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['access', 'key'],
  ['one', 'time'],
];

/** Does this text name a secret? Whole tokens only: "author" is not "auth",
 *  "spinner" is not "pin", "tokenizer" is not "token". */
export function namesASecret(text: string): boolean {
  const t = tokenizeParamName(text.replace(/2fa/gi, ' mfa '));
  if (t.some((x) => SECRET_TOKENS.has(x))) return true;
  for (let i = 0; i < t.length - 1; i++) {
    for (const [a, b] of SECRET_PAIRS) if (t[i] === a && t[i + 1] === b) return true;
  }
  return false;
}

/** Truncate without ever cutting a credential in half: a cut that lands inside
 *  a matched secret moves to where the secret starts. */
function truncateMessage(message: string, matches: readonly CredentialMatch[]): { text: string; truncated: boolean } {
  if (message.length <= ELICITATION_MESSAGE_MAX) return { text: message, truncated: false };
  let cut = ELICITATION_MESSAGE_MAX;
  for (const m of matches) {
    let from = message.indexOf(m.value);
    while (from !== -1) {
      if (from < cut && cut < from + m.value.length) cut = from;
      from = message.indexOf(m.value, from + 1);
    }
  }
  return { text: message.slice(0, cut), truncated: true };
}

function readFields(schema: unknown): { fields: ElicitationField[]; truncated: boolean; asksForSecret: boolean } {
  const out: ElicitationField[] = [];
  let asksForSecret = false;
  if (schema === null || typeof schema !== 'object') return { fields: out, truncated: false, asksForSecret };
  const s = schema as Record<string, unknown>;
  const props = s['properties'];
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    return { fields: out, truncated: false, asksForSecret };
  }
  const required = new Set(Array.isArray(s['required']) ? s['required'].filter((x): x is string => typeof x === 'string') : []);
  const entries = Object.entries(props as Record<string, unknown>);
  for (const [name, def] of entries) {
    const d = def !== null && typeof def === 'object' ? (def as Record<string, unknown>) : {};
    const title = str(d['title']);
    if (namesASecret(name) || (title !== undefined && namesASecret(title))) {
      asksForSecret = true;
    }
    if (out.length >= ELICITATION_MAX_FIELDS) continue;
    const type = str(d['type']);
    const format = str(d['format']);
    out.push({
      name: clip(name, ELICITATION_TITLE_MAX),
      ...(type !== undefined ? { type: clip(type, 20) } : {}),
      ...(title !== undefined ? { title: clip(title, ELICITATION_TITLE_MAX) } : {}),
      ...(format !== undefined ? { format: clip(format, 40) } : {}),
      required: required.has(name),
    });
  }
  return { fields: out, truncated: entries.length > ELICITATION_MAX_FIELDS, asksForSecret };
}

function readUrl(raw: string): ElicitationUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { unparseable: true, had_userinfo: /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw), had_fragment: raw.includes('#') };
  }
  // Credential-named values (token=, api_key=, sig=…) are replaced here, not
  // left for the ingester: a query value can hold characters JSON escapes,
  // which the line-level mask would then miss.
  const rawQuery = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  const query = rawQuery
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1 || eq === pair.length - 1) return pair;
      return isSecretQueryParam(pair.slice(0, eq)) ? `${pair.slice(0, eq)}=${QUERY_MASK}` : pair;
    })
    .join('&');
  const host = u.hostname;
  return {
    scheme: u.protocol.replace(/:$/, ''),
    host: clip(host, 255),
    ...(u.port !== '' ? { port: u.port } : {}),
    // Not truncated: a cut could split a credential the line mask then misses.
    path: u.pathname,
    ...(query !== '' ? { query } : {}),
    had_userinfo: u.username !== '' || u.password !== '',
    had_fragment: u.hash !== '' || raw.includes('#'),
    non_https: u.protocol !== 'https:',
    punycode_host: host.split('.').some((label) => label.startsWith('xn--')),
  };
}

/** The whitelist summary of an Elicitation hook payload, plus what the
 *  ingester needs to decide and to mask. Pure; never throws. */
export function readElicitation(raw: unknown): ElicitationReading {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const summary: ElicitationSummary = {};
  const maskSecrets: CredentialMatch[] = [];
  let asksForSecret = false;

  const server = str(o['mcp_server_name']);
  if (server !== undefined) summary.mcp_server_name = clip(server, ELICITATION_TITLE_MAX);
  const mode = str(o['mode']);
  if (mode !== undefined) summary.mode = clip(mode, 20);
  const id = str(o['elicitation_id']);
  if (id !== undefined) summary.elicitation_id = clip(id, ELICITATION_TITLE_MAX);

  const message = str(o['message']);
  if (message !== undefined) {
    const matches = credentialMatches(message);
    const { text, truncated } = truncateMessage(message, matches);
    summary.message = text;
    if (truncated) summary.message_truncated = true;
    maskSecrets.push(...matches);
  }

  if (mode !== 'url') {
    const { fields, truncated, asksForSecret: secret } = readFields(o['requested_schema']);
    if (fields.length > 0) summary.fields = fields;
    if (truncated) summary.fields_truncated = true;
    asksForSecret = secret;
  }

  const url = str(o['url']);
  if (url !== undefined) {
    summary.url = readUrl(url);
    maskSecrets.push(...credentialMatches(url));
  }

  return { summary, asksForSecret: mode !== 'url' && asksForSecret, maskSecrets };
}

/** ElicitationResult: server, mode, elicitation_id and the action — nothing
 *  else, and an action outside accept/decline/cancel is not kept. */
export function readElicitationResult(raw: unknown): Record<string, string> {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, string> = {};
  const server = str(o['mcp_server_name']);
  if (server !== undefined) fields['mcp_server_name'] = clip(server, ELICITATION_TITLE_MAX);
  const mode = str(o['mode']);
  if (mode !== undefined) fields['mode'] = clip(mode, 20);
  const id = str(o['elicitation_id']);
  if (id !== undefined) fields['elicitation_id'] = clip(id, ELICITATION_TITLE_MAX);
  const action = str(o['action']);
  if (action === 'accept' || action === 'decline' || action === 'cancel') fields['action'] = action;
  return fields;
}
