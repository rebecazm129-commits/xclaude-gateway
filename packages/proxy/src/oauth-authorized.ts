// oauth_authorized — what the trail keeps of a completed OAuth login, and the
// per-connector reference it is compared against.
//
// EMITTED ONLY when an authorization code was exchanged in this login process:
// the SDK redirected the user to the authorization server AND tokens were then
// saved (LoginOAuthProvider.authorizationCapture). A reconnect that succeeds
// through a refresh or a still-valid token is not a new authorization and
// records nothing — neither the event nor a reference update.
//
// KEPT (and nothing else): the authorization server as chosen from the
// protected resource metadata's authorization_servers (RFC 9728) — or, when the
// server published none, the SDK's fallback, marked as such —, the resource
// indicator sent (RFC 8707) or null — both canonical and redacted exactly like
// proxy.http_started.url (no userinfo, no fragment, credential query values
// masked) —, the scopes requested in the authorization URL, and the scopes granted:
// the token response's `scope` when it carries one, else the requested ones,
// marked scope_source 'assumed_requested'. NEVER a token, the code, state, the
// PKCE verifier, client_id, the callback URL or any metadata document: the
// capture reads two query parameters off the authorization URL and drops it.
//
// REFERENCE: one small file per connector under oauth/v1/ in the data folder
// (the manifests/v2 pattern: atomic temp + fsync + rename, 0600 in a 0700 dir,
// a newer storage_version is never overwritten). It is ALWAYS rewritten after
// the event, finding or not — the same change must not be reported on every
// login. The trail is never read: a missing or unreadable file is reported as
// its own event (proxy.oauth_reference) and the login counts as the first one.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { JsonlWriter } from './audit.js';
import { canonicalizeUrl } from './detection/launch-redaction.js';
import { sha256 } from './detection/manifest-v2.js';
import { resolveAuditKey } from './detection/masking.js';
import { EventSink, type EventBody } from './events.js';

/** What the login provider saw, already reduced to the kept fields. */
export interface AuthorizationCapture {
  /** Exact value chosen by the SDK (authorization_servers[0], or its fallback). */
  authorizationServer: string;
  authorizationServerSource: 'protected_resource_metadata' | 'server_url_fallback';
  /** The `resource` parameter of the authorization URL, raw; null when absent. */
  resource: string | null;
  /** The `scope` parameter of the authorization URL, split; [] when absent. */
  requestedScopes: string[];
  /** The token response's `scope`, split; null when the response had none. */
  grantedScopes: string[] | null;
}

export const OAUTH_RULE_VERSION = 1;

export type OAuthRuleId = 'authorization_server_changed' | 'scopes_expanded';

export interface OAuthFinding {
  rule_id: OAuthRuleId;
  rule_version: number;
  severity: 'high' | 'medium';
  before?: string;
  after?: string;
  added?: string[];
}

/** Facts that differ from the reference but are not findings. */
export interface OAuthChange {
  field: 'resource' | 'scopes_reduced';
  before?: string | null;
  after?: string | null;
  removed?: string[];
}

// ---------------------------------------------------------------------------
// normalization

/** Scheme and host lowercase (WHATWG URL does both), path without a trailing
 *  slash; query and fragment dropped. Unparseable: trimmed, lowercased, no
 *  trailing slash. Used for COMPARISON only — the event keeps the canonical,
 *  redacted value. */
export function normalizeAuthorizationServer(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/** A scope string or list → the effective set: split on whitespace, deduped,
 *  sorted, so order and repetition never read as a change. */
export function normalizeScopes(scopes: string | readonly string[] | null | undefined): string[] {
  if (scopes === null || scopes === undefined) return [];
  const parts = typeof scopes === 'string' ? scopes.split(/\s+/) : scopes.flatMap((s) => s.split(/\s+/));
  return [...new Set(parts.filter((s) => s.length > 0))].sort();
}

// ---------------------------------------------------------------------------
// reference file

const STORAGE_VERSION = 1;

export interface OAuthReference {
  storage_version: number;
  mcp: string;
  /** +1 on every write. */
  generation: number;
  updated_at: string;
  authorization_server: string;
  resource: string | null;
  effective_granted_scopes: string[];
}

export type ReferenceRead =
  | { kind: 'missing' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'future'; storageVersion: number }
  | { kind: 'ok'; reference: OAuthReference };

export function oauthReferenceDir(baseDir: string): string {
  return join(baseDir, 'oauth', 'v1');
}

export function oauthReferencePath(baseDir: string, mcp: string): string {
  const safe = mcp.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';
  return join(oauthReferenceDir(baseDir), `${safe}.${sha256(mcp).slice(0, 12)}.json`);
}

export function readOAuthReference(baseDir: string, mcp: string): ReferenceRead {
  let raw: string;
  try {
    raw = readFileSync(oauthReferencePath(baseDir, mcp), 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', detail: 'unparseable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'corrupt', detail: 'not an object' };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o['storage_version'] === 'number' && o['storage_version'] > STORAGE_VERSION) {
    return { kind: 'future', storageVersion: o['storage_version'] };
  }
  if (
    o['storage_version'] !== STORAGE_VERSION ||
    o['mcp'] !== mcp ||
    typeof o['generation'] !== 'number' ||
    typeof o['authorization_server'] !== 'string' ||
    !(typeof o['resource'] === 'string' || o['resource'] === null) ||
    !Array.isArray(o['effective_granted_scopes']) ||
    !o['effective_granted_scopes'].every((s) => typeof s === 'string')
  ) {
    return { kind: 'corrupt', detail: 'unexpected shape' };
  }
  return { kind: 'ok', reference: o as unknown as OAuthReference };
}

/** Atomic write (temp in the same dir, fsync, rename). Never throws. */
export function writeOAuthReference(baseDir: string, reference: OAuthReference): { ok: boolean; error?: string } {
  const path = oauthReferencePath(baseDir, reference.mcp);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(oauthReferenceDir(baseDir), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(reference, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// comparison

export function compareWithReference(
  previous: OAuthReference,
  current: { authorizationServer: string; resource: string | null; effectiveGrantedScopes: readonly string[] },
): { findings: OAuthFinding[]; changes: OAuthChange[] } {
  const findings: OAuthFinding[] = [];
  const changes: OAuthChange[] = [];
  if (normalizeAuthorizationServer(previous.authorization_server) !== normalizeAuthorizationServer(current.authorizationServer)) {
    findings.push({
      rule_id: 'authorization_server_changed',
      rule_version: OAUTH_RULE_VERSION,
      severity: 'high',
      before: previous.authorization_server,
      after: current.authorizationServer,
    });
  }
  const before = new Set(normalizeScopes(previous.effective_granted_scopes));
  const after = new Set(normalizeScopes(current.effectiveGrantedScopes));
  const added = [...after].filter((s) => !before.has(s));
  const removed = [...before].filter((s) => !after.has(s));
  if (added.length > 0) {
    findings.push({ rule_id: 'scopes_expanded', rule_version: OAUTH_RULE_VERSION, severity: 'medium', added });
  }
  if (removed.length > 0) changes.push({ field: 'scopes_reduced', removed });
  if (previous.resource !== current.resource) {
    changes.push({ field: 'resource', before: previous.resource, after: current.resource });
  }
  return { findings, changes };
}

// ---------------------------------------------------------------------------
// recording

export interface RecordDeps {
  baseDir: string;
  sink: EventSink;
  /** Redaction key for the resource URL (the audit key). */
  auditKey: Buffer;
  now?: () => string;
}

/** Emits proxy.oauth_reference (when the reference was missing/corrupt/newer),
 *  then oauth_authorized, then rewrites the reference. Returns the events for
 *  the caller's own use (tests); the sink already has them. */
export function recordOAuthAuthorized(mcp: string, capture: AuthorizationCapture, deps: RecordDeps): EventBody[] {
  const now = deps.now ?? (() => new Date().toISOString());
  const authorizationServer = canonicalizeUrl(capture.authorizationServer, deps.auditKey);
  const resource = capture.resource === null ? null : canonicalizeUrl(capture.resource, deps.auditKey);
  const requested = normalizeScopes(capture.requestedScopes);
  const granted = capture.grantedScopes === null ? requested : normalizeScopes(capture.grantedScopes);
  const current = { authorizationServer, resource, effectiveGrantedScopes: granted };

  const events: EventBody[] = [];
  const read = readOAuthReference(deps.baseDir, mcp);
  let previous: OAuthReference | null = null;
  if (read.kind === 'ok') {
    previous = read.reference;
  } else if (read.kind === 'missing') {
    events.push({ type: 'proxy.oauth_reference', event: 'initialized', reason: 'missing' });
  } else if (read.kind === 'corrupt') {
    events.push({ type: 'proxy.oauth_reference', event: 'reseeded', reason: 'corrupt' });
  } else {
    events.push({ type: 'proxy.oauth_reference', event: 'kept_newer', reason: 'future_version' });
  }

  const { findings, changes } =
    previous === null ? { findings: [], changes: [] } : compareWithReference(previous, current);
  events.push({
    type: 'proxy.oauth_authorized',
    authorization_server: authorizationServer,
    authorization_server_source: capture.authorizationServerSource,
    resource,
    requested_scopes: requested,
    effective_granted_scopes: granted,
    scope_source: capture.grantedScopes === null ? 'assumed_requested' : 'token_response',
    first_login: previous === null,
    // When the compared login happened: the reference's own write time.
    previous_login_at: previous === null ? null : previous.updated_at,
    changes,
    findings,
  });
  for (const ev of events) deps.sink.emit(ev);

  // A newer build's file is never overwritten (manifests/v2 rule).
  if (read.kind !== 'future') {
    const written = writeOAuthReference(deps.baseDir, {
      storage_version: STORAGE_VERSION,
      mcp,
      generation: previous === null ? 1 : previous.generation + 1,
      updated_at: now(),
      authorization_server: authorizationServer,
      resource,
      effective_granted_scopes: granted,
    });
    if (!written.ok) {
      const ev: EventBody = { type: 'proxy.oauth_reference', event: 'write_failed', reason: 'io_error' };
      deps.sink.emit(ev);
      events.push(ev);
    }
  }
  return events;
}

export function defaultDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'xCLAUDE Gateway');
}

/** The login process's own trail file: wrappers/<ulid>.jsonl, like a wrapper
 *  session, with the same audit key. */
export function recordOAuthAuthorizedToDisk(mcp: string, capture: AuthorizationCapture, baseDir = defaultDataDir()): void {
  const session = ulid();
  const auditKey = resolveAuditKey(baseDir);
  const sink = new EventSink(mcp, [new JsonlWriter(join(baseDir, 'wrappers', `${session}.jsonl`))], session, auditKey);
  try {
    recordOAuthAuthorized(mcp, capture, { baseDir, sink, auditKey });
  } finally {
    sink.close();
  }
}
