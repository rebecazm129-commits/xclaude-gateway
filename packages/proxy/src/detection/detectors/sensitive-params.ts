// Sensitive parameter names — the signal that turns "a tool grew" into "a tool
// grew a way to move data somewhere".
//
// WHAT THE MATCHER DOES, precisely. A parameter name is tokenised into
// lowercase words, and it counts as sensitive if ANY of four rules hits:
//
//   1. ANYWHERE   — a token is in SENSITIVE_TOKENS (url, webhook, bcc, token,
//                   password…). Position does not matter: source_url, fileUrl
//                   and url all hit.
//   2. FIRST-ONLY — a token is in POSITIONAL_TOKENS (`to`, `cc`) AND it is the
//                   whole name or its FIRST token. `to` and `to_address` and
//                   `cc_list` hit; `path_to_file`, `convert_to_markdown`,
//                   `days_to_wait_before_mark_as_response` and `replyToMessageId`
//                   do not. These two words are too common as English
//                   prepositions to match mid-name: on the production corpus
//                   `to` collided with 11 of the 13 names it touched.
//   3. PAIR       — two CONSECUTIVE tokens match an entry in SENSITIVE_PAIRS
//                   (api key, access key, private key, secret key). Bare `key`
//                   is deliberately NOT a token on its own: tokenising does
//                   nothing for projectKey, issueIdOrKey or descriptionKey,
//                   which are Jira/Linear identifiers and split to
//                   [project, key] — a whole-word match would still fire.
//   4. COMPOUND   — the whole token matches SENSITIVE_COMPOUNDS (apikey,
//                   accesstoken, authtoken, privatekey, secretkey). These
//                   carry no separator, so the tokeniser cannot split them and
//                   rules 1-3 never see their parts.
//
// What tokenising fixes and what it does NOT: it fixes `author` (one token,
// never `auth`) and `unfurl_app_links` (`links` is not `link`). It does NOT
// fix `projectKey` — hence rule 3 rather than a bare `key`.
//
// The list is deliberately NOT fitted to the corpus: most of these tokens
// never appeared in a newly-added parameter in four months of production
// traffic. They are a tripwire for what has not happened yet, not a classifier
// trained on what has.

/** Splits a parameter name into lowercase words. Handles snake_case,
 *  kebab-case, camelCase, PascalCase, digits and consecutive capitals:
 *    source_url   -> [source, url]
 *    bccEmails    -> [bcc, emails]
 *    HTTPHeaders  -> [http, headers]
 *    x-api-key    -> [x, api, key]
 *    oauth2Token  -> [oauth, token] */
export function tokenizeParamName(name: string): string[] {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .split(/[^A-Za-z]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/** Rule 1 — matched in any position. */
export const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  // destinations
  'url', 'uri', 'link', 'webhook', 'callback', 'endpoint', 'redirect',
  // recipients ('email' singular is excluded: on the corpus it was 6/6 config
  // flags — run_waterfall_email, create_task_if_email_open — while the plural
  // was always a recipient list)
  'bcc', 'recipient', 'recipients', 'emails',
  // payload carriers ('file' excluded: its only true positive, file_upload, is
  // already caught by `upload`, and it added source_file_id as a false one)
  'upload', 'attachment',
  // credentials (bare 'key' excluded — see rule 3)
  'token', 'secret', 'credential', 'credentials', 'password', 'auth',
  // transport
  'header', 'headers',
]);

/** Rule 2 — only as the whole name or the first token. */
export const POSITIONAL_TOKENS: ReadonlySet<string> = new Set(['to', 'cc']);

/** Rule 3 — consecutive token pairs. */
export const SENSITIVE_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
];

/** Rule 4 — separator-less compounds the tokeniser cannot split. */
export const SENSITIVE_COMPOUNDS: ReadonlySet<string> = new Set([
  'apikey', 'accesstoken', 'authtoken', 'privatekey', 'secretkey',
]);

// Rule-1 tokens that name a CREDENTIAL, as opposed to a destination, a
// recipient or a transport. A subset of SENSITIVE_TOKENS, not a second list:
// launch-arg redaction must only ever act on evidence of a secret, and `url`,
// `endpoint`, `header` or `upload` in a flag name say where something goes,
// not that its value is secret.
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  'token', 'secret', 'credential', 'credentials', 'password', 'auth',
]);

/** Does this flag or variable NAME carry a credential? Same tokenizer, pairs
 *  and compounds as isSensitiveParamName, restricted to CREDENTIAL_TOKENS.
 *  API_KEY, --access-token, figmaApiKey, DB_PASSWORD: yes. DATABASE_URL,
 *  --base-url, --header, --key: no. */
export function isCredentialName(name: string): boolean {
  const t = tokenizeParamName(name);
  if (t.length === 0) return false;
  if (t.some((x) => CREDENTIAL_TOKENS.has(x) || SENSITIVE_COMPOUNDS.has(x))) return true;
  for (let i = 0; i < t.length - 1; i++) {
    for (const [a, b] of SENSITIVE_PAIRS) {
      if (t[i] === a && t[i + 1] === b) return true;
    }
  }
  return false;
}

export function isSensitiveParamName(name: string): boolean {
  const t = tokenizeParamName(name);
  if (t.length === 0) return false;
  if (t.some((x) => SENSITIVE_TOKENS.has(x) || SENSITIVE_COMPOUNDS.has(x))) return true;
  if (POSITIONAL_TOKENS.has(t[0]!)) return true;
  for (let i = 0; i < t.length - 1; i++) {
    for (const [a, b] of SENSITIVE_PAIRS) {
      if (t[i] === a && t[i + 1] === b) return true;
    }
  }
  return false;
}
