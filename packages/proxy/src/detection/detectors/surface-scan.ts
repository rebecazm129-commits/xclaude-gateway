// Full-surface scan of a Tool definition.
//
// WHY A GENERIC WALKER. The 24/09 probe showed the manifest detector reading
// exactly one string: the tool's top-level `description`. An instruction moved
// into `inputSchema.properties.<p>.description`, into a `default`, an `enum`
// member, a vendor field like `x-usage-hint`, or a `$defs` branch was invisible
// — three separate probe cases all came out as a generic schema_changed.
//
// So this walker knows NOTHING about JSON Schema. It has no keyword list, no
// notion of which fields "can" carry text. It visits every key and every string
// value of the object and reports what it finds with a JSON path. A schema
// keyword nobody has invented yet is covered on the day a vendor ships it,
// because the walker never had an opinion about keywords in the first place.
//
// $ref IS NEVER RESOLVED. Following a reference would mean fetching or
// reassembling a document the proxy did not observe. An external $ref is
// recorded as a finding and left alone.

import { normalizeForAnalysis } from './text-normalize.js';

export type SurfaceKind = 'key' | 'value';

export interface SurfaceEntry {
  /** JSON path of the entry, e.g. `$.inputSchema.properties.query.description`.
   *  For a key, the path of the key itself. */
  path: string;
  kind: SurfaceKind;
  /** The text as it appeared. Kept verbatim: this is evidence. */
  raw: string;
  /** NFKC, zero-width and tag characters removed. Analysis only. */
  normalized: string;
}

const MAX_ENTRIES = 5_000;

function pushEntry(out: SurfaceEntry[], path: string, kind: SurfaceKind, raw: string): void {
  if (out.length >= MAX_ENTRIES) return;
  out.push({ path, kind, raw, normalized: normalizeForAnalysis(raw) });
}

/**
 * Every key name and every string value of `root`, with its JSON path.
 * Arrays index numerically; object keys are reported as `key` entries so a
 * poisoned PARAMETER NAME is surface too.
 */
export function walkSurface(root: unknown): SurfaceEntry[] {
  const out: SurfaceEntry[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown, path: string): void => {
    if (out.length >= MAX_ENTRIES) return;
    if (typeof node === 'string') {
      pushEntry(out, path, 'value', node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; // cycles: a manifest is JSON, but never trust it
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const child = `${path}.${k}`;
      pushEntry(out, child, 'key', k);
      visit(v, child);
    }
  };
  visit(root, '$');
  return out;
}

/** External $ref values, recorded and never followed. A ref starting with `#`
 *  points inside the same document and is left out: the walker already visited
 *  whatever it points at. */
export function externalRefs(entries: readonly SurfaceEntry[]): SurfaceEntry[] {
  return entries.filter(
    (e) => e.kind === 'value' && e.path.endsWith('.$ref') && !e.raw.trimStart().startsWith('#'),
  );
}

// ---- sensitive path references ----------------------------------------------
//
// These fire on the SHAPE of a real filesystem path, never on a bare word.
// `token`, `secret`, `ssh`, `keychain`, `credential`, `env`, `password`, `seed`
// and `mnemonic` appear constantly in legitimate tool prose ("returns an access
// token", "the environment"), so a word list here would be pure noise. What
// distinguishes a reference to a credential FILE is that it looks like a path:
// it is rooted (~/, $HOME/, /Users/<u>/, /home/<u>/, /etc/), or it carries
// several components (.aws/credentials), or its basename is specific enough to
// mean only one thing (.git-credentials, .npmrc, .netrc).

export interface PathRule {
  /** Stable id reported in the finding — the WHY, not a verdict. */
  rule: string;
  pattern: RegExp;
}

/** Rooted prefix, optional: a bare `.ssh/id_rsa` already carries two
 *  components, which is enough on its own. */
const ROOT = String.raw`(?:~|\$HOME|/Users/[^/\s"']+|/home/[^/\s"']+|/etc)?/?`;
/** The reference must start at a boundary, not mid-word. */
const EDGE = String.raw`(?<![\w.-])`;

export const SENSITIVE_PATH_RULES: readonly PathRule[] = [
  { rule: 'ssh_private_key', pattern: new RegExp(`${EDGE}${ROOT}\\.ssh/id_(?:rsa|ed25519|ecdsa|dsa)\\b`, 'i') },
  { rule: 'aws_credentials', pattern: new RegExp(`${EDGE}${ROOT}\\.aws/(?:credentials|config)\\b`, 'i') },
  { rule: 'gcloud_adc', pattern: new RegExp(`${EDGE}${ROOT}\\.config/gcloud/application_default_credentials\\.json\\b`, 'i') },
  { rule: 'git_credentials', pattern: new RegExp(`${EDGE}(?:${ROOT}\\.git-credentials|${ROOT}\\.config/git/credentials)\\b`, 'i') },
  { rule: 'npmrc', pattern: new RegExp(`${EDGE}${ROOT}\\.npmrc\\b`, 'i') },
  { rule: 'netrc', pattern: new RegExp(`${EDGE}${ROOT}\\.netrc\\b`, 'i') },
  { rule: 'kubeconfig', pattern: new RegExp(`${EDGE}${ROOT}\\.kube/config\\b`, 'i') },
  { rule: 'docker_config', pattern: new RegExp(`${EDGE}${ROOT}\\.docker/config\\.json\\b`, 'i') },
  { rule: 'claude_desktop_config', pattern: new RegExp(`${EDGE}(?:Claude/)?claude_desktop_config\\.json\\b`, 'i') },
  { rule: 'cursor_mcp_config', pattern: new RegExp(`${EDGE}${ROOT}\\.cursor/mcp\\.json\\b`, 'i') },
  { rule: 'keychain', pattern: new RegExp(`${EDGE}${ROOT}Library/Keychains/`, 'i') },
];

/** `.env` and `.env.<x>`, minus the template names every repo ships. */
const DOTENV = /(?<![\w.-])(?:~|\$HOME|\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/etc)?\/?\.env(\.[A-Za-z0-9_-]+)*\b/i;
const DOTENV_EXEMPT = /^\.(?:example|sample|template)$|^\.example\.local$/i;

function matchesDotenv(text: string): boolean {
  const m = DOTENV.exec(text);
  if (m === null) return false;
  const suffix = m[1] ?? '';
  // `.env.example`, `.env.sample`, `.env.template`, `.env.example.local`.
  return !DOTENV_EXEMPT.test(suffix);
}

export interface PathHit {
  rule: string;
  path: string;
  kind: SurfaceKind;
}

/** Path-shaped credential references anywhere in the walked surface. Matched
 *  on the NORMALIZED view so zero-width padding cannot break a pattern. */
export function sensitivePathHits(entries: readonly SurfaceEntry[]): PathHit[] {
  const out: PathHit[] = [];
  for (const e of entries) {
    for (const { rule, pattern } of SENSITIVE_PATH_RULES) {
      if (pattern.test(e.normalized)) out.push({ rule, path: e.path, kind: e.kind });
    }
    if (matchesDotenv(e.normalized)) out.push({ rule: 'dotenv', path: e.path, kind: e.kind });
  }
  return out;
}
