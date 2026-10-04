// Reading connector changes in BOTH formats, without rewriting a byte of the
// trail.
//
// Native lines are mcp.connector_change. Everything recorded before the facts
// model is an mcp.detection_enrichment carrying detection.category ===
// 'tool_manifest_changed' — 317 of them in the operator's own trail at the time
// of writing, spanning four months. They are reconstructed into the same view
// so one reader serves both, and marked source_format so a consumer never
// mistakes a reconstruction for a native record.
//
// WHAT A RECONSTRUCTION CANNOT SAY, and therefore does not:
//   - snapshot. The old line carried no hashes, so it is null. That is also
//     why a historical change can never be re-judged by a later heuristic:
//     there is nothing to measure against.
//   - rule_version. These findings predate versioning, so they carry 0, which
//     reads as "emitted before rules were versioned" rather than as version 1,
//     which would be a lie about which rule decided.
//   - external_url / imperative_language / external_ref. These were
//     informational findings that never raised severity and have no place in
//     either list of the facts model. They are dropped from the view and
//     remain, untouched, in the raw trail line.
//
// WHAT THE HISTORY ACTUALLY HOLDS, measured over the operator's own trail on
// 24/09: 317 manifest lines, and ZERO security-rule findings among them. Every
// finding ever written is a shape one (schema_changed 325, description_changed
// 266, tool_added 186, surface_added 92, tool_removed 76) plus six
// informational. The 91 lines graded `high` were graded by the pre-shape rule
// retired on 24/09, not by a rule finding — so that severity has no
// representation here, and deliberately none: it was retired because it was
// wrong, and carrying it forward would launder a judgement we stopped trusting.
//
// The consequence is worth stating plainly: every reconstructed event lands in
// Changes and none in Detections. The 20 events that DO carry
// sensitive_param_added come from replaying today's detector over the raw
// tools/list responses, which is a different thing from what the trail records.
//
// Per-finding severity did not exist before the model: the old line carried one
// severity for the whole event. Rather than stamp that maximum onto every
// finding (overstating the small ones) or re-grade with today's rules
// (re-judging the past), each finding gets the severity its rule meant AT
// EMISSION TIME, which is fixed and, for hidden_characters, recoverable from
// the line's own class field.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CONNECTOR_CHANGE_TYPE,
  REVIEW_STATUS_CHANGED_TYPE,
  isReviewStatusChangedEvent,
  type ReviewStatus,
  type Attention,
  type ChangeKind,
  type ChangeReview,
  type ConnectorChangeEntry,
  type ConnectorFinding,
  type ConnectorSection,
  type ReviewedWith,
  type RuleId,
  type SnapshotRef,
} from '@xcg/shared';

import { listJsonlFiles } from './detection-reader.js';
import { CHANGE_NOTIFIED_TYPE } from './recovery-writer.js';

/** A connector change is either a surface section or the connector's OAuth
 *  authorization. 'authorization' is a desktop view section only: the proxy
 *  never writes it on an mcp.connector_change, so the shared type stays as is. */
export type ChangeSection = ConnectorSection | 'authorization';

/** The two OAuth rules (proxy/src/oauth-authorized.ts). Kept out of the shared
 *  RuleId on purpose: that union keys the proxy's catalog-review versions. */
export type AuthorizationRuleId = 'authorization_server_changed' | 'scopes_expanded';

export type ChangeFinding = Omit<ConnectorFinding, 'rule_id'> & { rule_id: RuleId | AuthorizationRuleId };

/** What the drawer shows for an authorization row: before → now, from the
 *  proxy.oauth_authorized line alone (it carries the added/removed sets and
 *  the previous server, so the previous state is reconstructed, not read). */
export interface AuthorizationView {
  authorization_server: { before: string | null; now: string };
  authorization_server_source: 'protected_resource_metadata' | 'server_url_fallback';
  scopes: { before: string[] | null; now: string[]; added: string[]; removed: string[] };
  requested_scopes: string[];
  scope_source: 'token_response' | 'assumed_requested';
  resource: { before: string | null; now: string | null; changed: boolean };
  first_login: boolean;
  previous_login_at: string | null;
  /** The proxy.oauth_reference note of the same login, when there was one. */
  reference_note?: 'initialized' | 'reseeded' | 'kept_newer' | 'write_failed';
}

/** One change as the UI and the export see it, whatever format it came from. */
export interface ReviewStep {
  ts: string;
  from: ReviewStatus;
  to: ReviewStatus;
}

export interface ConnectorChangeView {
  event_id: string;
  ts: string;
  mcp: string;
  section: ChangeSection;
  snapshot: SnapshotRef | null;
  changes: ConnectorChangeEntry[];
  findings: ChangeFinding[];
  attention: Attention;
  /** Folded from the app.review_status_changed lines, never stored on the
   *  event. A change with no marker pointing at it is unreviewed, which is why
   *  a surface that returns to a reviewed state starts over: the new event has
   *  a new id. */
  review_status: ReviewStatus;
  review_history: ReviewStep[];
  source_format?: 'tool_manifest_changed_v1';
  /** A catalog review: findings about the definition as it stands, no
   *  changes. Native lines only. */
  review?: ChangeReview;
  reviewed_with?: ReviewedWith;
  /** Authorization rows only. */
  authorization?: AuthorizationView;
  /** An app.change_notified marker points at this event: the macOS
   *  notification was already decided (shown or refused). */
  notified?: boolean;
}

const LEGACY_TYPE = 'mcp.detection_enrichment';
const LEGACY_CATEGORY = 'tool_manifest_changed';

/** Old finding type → what moved. Anything absent here is not a change. */
const CHANGE_OF: Readonly<Record<string, ChangeKind>> = {
  tool_added: 'item_added',
  tool_removed: 'item_removed',
  description_changed: 'description_changed',
  surface_added: 'surface_added',
  schema_changed: 'schema_changed',
};

const RULE_OF = new Set<string>([
  'sensitive_param_added',
  'sensitive_path_reference',
  'injection_marker',
  'hidden_characters',
]);

/** Version stamped on findings that predate rules.ts. Never 1: a reader must be
 *  able to tell "before versioning" from "version one". */
export const UNVERSIONED = 0;

/** Hidden-character classes that meant high when these lines were written. */
const HIGH_HIDDEN_CLASSES = new Set(['tag', 'bidi']);

function legacySeverity(type: string, rule: string | undefined): ConnectorFinding['severity'] {
  if (type === 'hidden_characters') {
    return rule !== undefined && HIGH_HIDDEN_CLASSES.has(rule) ? 'high' : 'medium';
  }
  return 'high';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** A legacy enrichment line → the same view a native line produces. */
export function fromLegacyLine(value: unknown): ConnectorChangeView | null {
  if (!isRecord(value) || value['type'] !== LEGACY_TYPE) return null;
  const det = value['detection'];
  if (!isRecord(det) || det['category'] !== LEGACY_CATEGORY) return null;
  const id = value['id'];
  const ts = value['ts'];
  const mcp = value['mcp'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof mcp !== 'string') return null;

  const changes: ConnectorChangeEntry[] = [];
  const findings: ConnectorFinding[] = [];
  const raw = Array.isArray(det['findings']) ? det['findings'] : [];
  for (const f of raw) {
    if (!isRecord(f) || typeof f['type'] !== 'string') continue;
    const type = f['type'];
    const location = typeof f['location'] === 'string' ? f['location'] : '';
    const path = typeof f['path'] === 'string' ? f['path'] : undefined;
    const rule = typeof f['rule'] === 'string' ? f['rule'] : undefined;
    const kind = CHANGE_OF[type];
    if (kind !== undefined) {
      changes.push({ kind, target: location, ...(path !== undefined ? { path } : {}) });
      continue;
    }
    if (!RULE_OF.has(type)) continue; // informational: not a change, not a verdict
    const evidence: ConnectorFinding['evidence'] = {};
    // sensitive_param_added put `tool.param` in location; the tool is the part
    // before the first dot, which is how it was written.
    if (location !== '') {
      evidence.target = type === 'sensitive_param_added' ? location.split('.')[0]! : location;
      if (type === 'sensitive_param_added') evidence.path = location;
    }
    if (path !== undefined) evidence.path = path;
    if (rule !== undefined) evidence.rule = rule;
    if (typeof f['codepoint'] === 'string') evidence.codepoint = f['codepoint'];
    if (typeof f['count'] === 'number') evidence.count = f['count'];
    findings.push({
      rule_id: type as RuleId,
      rule_version: UNVERSIONED,
      severity: legacySeverity(type, rule),
      evidence,
    });
  }
  if (changes.length === 0 && findings.length === 0) return null;
  return {
    event_id: id,
    ts,
    mcp,
    section: 'tools', // the only section the old detector ever watched
    snapshot: null,
    changes,
    findings,
    attention: { level: 'normal' },
    review_status: 'unreviewed',
    review_history: [],
    source_format: 'tool_manifest_changed_v1',
  };
}

/** A native mcp.connector_change line → the view, unchanged. */
export function fromNativeLine(value: unknown): ConnectorChangeView | null {
  if (!isRecord(value) || value['type'] !== CONNECTOR_CHANGE_TYPE) return null;
  const id = value['id'];
  const ts = value['ts'];
  const mcp = value['mcp'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof mcp !== 'string') return null;
  if (!Array.isArray(value['changes']) || !Array.isArray(value['findings'])) return null;
  const section = value['section'];
  const attention = value['attention'];
  const review = value['review'];
  const reviewedWith = value['reviewed_with'];
  return {
    event_id: id,
    ts,
    mcp,
    section: (typeof section === 'string' ? section : 'tools') as ConnectorSection,
    snapshot: (value['snapshot'] ?? null) as SnapshotRef | null,
    changes: value['changes'] as ConnectorChangeEntry[],
    findings: value['findings'] as ConnectorFinding[],
    attention: (isRecord(attention) ? attention : { level: 'normal' }) as Attention,
    review_status: 'unreviewed',
    review_history: [],
    ...(review === 'baseline' ? { review } : {}),
    ...(isRecord(reviewedWith) ? { reviewed_with: reviewedWith as ReviewedWith } : {}),
  };
}

export const OAUTH_AUTHORIZED_TYPE = 'proxy.oauth_authorized';
export const OAUTH_REFERENCE_TYPE = 'proxy.oauth_reference';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const REFERENCE_NOTES = new Set(['initialized', 'reseeded', 'kept_newer', 'write_failed']);

/**
 * A proxy.oauth_authorized line → an authorization row, or null when there is
 * nothing to show. Like a manifest observation with no change, a login that
 * matches the previous one is not a row (the line stays in the trail). A first
 * login is, as the reference everything later is compared with.
 */
export function fromOAuthLine(
  value: unknown,
  referenceNote?: AuthorizationView['reference_note'],
): ConnectorChangeView | null {
  if (!isRecord(value) || value['type'] !== OAUTH_AUTHORIZED_TYPE) return null;
  const id = value['id'];
  const ts = value['ts'];
  const mcp = value['mcp'];
  const server = value['authorization_server'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof mcp !== 'string' || typeof server !== 'string') {
    return null;
  }
  const firstLogin = value['first_login'] === true;
  const now = strings(value['effective_granted_scopes']);
  const resourceNow = typeof value['resource'] === 'string' ? value['resource'] : null;

  const findings: ChangeFinding[] = [];
  let serverBefore: string | null = firstLogin ? null : server;
  let added: string[] = [];
  for (const f of Array.isArray(value['findings']) ? value['findings'] : []) {
    if (!isRecord(f)) continue;
    const version = typeof f['rule_version'] === 'number' ? f['rule_version'] : UNVERSIONED;
    if (f['rule_id'] === 'authorization_server_changed') {
      if (typeof f['before'] === 'string') serverBefore = f['before'];
      findings.push({
        rule_id: 'authorization_server_changed',
        rule_version: version,
        severity: 'high',
        evidence: { target: hostOf(server) },
      });
    } else if (f['rule_id'] === 'scopes_expanded') {
      added = strings(f['added']);
      findings.push({
        rule_id: 'scopes_expanded',
        rule_version: version,
        severity: 'medium',
        evidence: { count: added.length },
      });
    }
  }
  let removed: string[] = [];
  let resourceBefore: string | null = firstLogin ? null : resourceNow;
  let resourceChanged = false;
  for (const c of Array.isArray(value['changes']) ? value['changes'] : []) {
    if (!isRecord(c)) continue;
    if (c['field'] === 'scopes_reduced') removed = strings(c['removed']);
    if (c['field'] === 'resource') {
      resourceChanged = true;
      resourceBefore = typeof c['before'] === 'string' ? c['before'] : null;
    }
  }

  const noteworthy =
    firstLogin ||
    findings.length > 0 ||
    removed.length > 0 ||
    resourceChanged ||
    referenceNote === 'kept_newer' ||
    referenceNote === 'write_failed';
  if (!noteworthy) return null;

  const addedSet = new Set(added);
  const scopesBefore = firstLogin ? null : [...now.filter((s) => !addedSet.has(s)), ...removed].sort();
  return {
    event_id: id,
    ts,
    mcp,
    section: 'authorization',
    snapshot: null,
    changes: [
      ...added.map((target) => ({ kind: 'item_added' as const, target })),
      ...removed.map((target) => ({ kind: 'item_removed' as const, target })),
    ],
    findings,
    attention: { level: 'normal' },
    review_status: 'unreviewed',
    review_history: [],
    authorization: {
      authorization_server: { before: serverBefore, now: server },
      authorization_server_source:
        value['authorization_server_source'] === 'server_url_fallback' ? 'server_url_fallback' : 'protected_resource_metadata',
      scopes: { before: scopesBefore, now, added, removed },
      requested_scopes: strings(value['requested_scopes']),
      scope_source: value['scope_source'] === 'assumed_requested' ? 'assumed_requested' : 'token_response',
      resource: { before: resourceBefore, now: resourceNow, changed: resourceChanged },
      first_login: firstLogin,
      previous_login_at: typeof value['previous_login_at'] === 'string' ? value['previous_login_at'] : null,
      ...(referenceNote !== undefined ? { reference_note: referenceNote } : {}),
    },
  };
}

/** The host of a URL, or the value itself when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A proxy.oauth_reference line's note, or null. */
function referenceNoteOf(value: unknown): { session: string; note: NonNullable<AuthorizationView['reference_note']> } | null {
  if (!isRecord(value) || value['type'] !== OAUTH_REFERENCE_TYPE) return null;
  const session = value['session'];
  const note = value['event'];
  if (typeof session !== 'string' || typeof note !== 'string' || !REFERENCE_NOTES.has(note)) return null;
  return { session, note: note as NonNullable<AuthorizationView['reference_note']> };
}

/** An app.change_notified marker's target, or null. */
function notifiedTargetOf(value: unknown): string | null {
  if (!isRecord(value) || value['type'] !== CHANGE_NOTIFIED_TYPE) return null;
  return typeof value['target_event_id'] === 'string' ? value['target_event_id'] : null;
}

/** What makes two review lines the same record: everything the event
 *  states, minus its id, time and session — and minus the rule versions. A
 *  rule's version going up re-reviews every stored catalog with the WHOLE
 *  rule, so a finding already reported comes back stamped with the new
 *  version; it is the same finding, and shows once. */
function duplicateKey(v: ConnectorChangeView): string {
  return JSON.stringify([
    v.section,
    v.snapshot,
    v.changes,
    v.findings.map((f) => ({ ...f, rule_version: undefined })), // dropped by stringify
    v.attention,
    v.review ?? null,
  ]);
}

/**
 * Two proxies of the same connector (two clients, or a restart racing the old
 * process) can each review the same catalog and each write the same line. The
 * trail keeps both — it is evidence of what each process did — but the list
 * shows one: consecutive CATALOG REVIEW lines of the same connector that state
 * exactly the same thing collapse into the newest. A reviewed copy wins over
 * an unreviewed one, so a mark is never hidden — which is also how a
 * re-review after a version bump inherits the mark of the review it repeats.
 *
 * Only review lines. Change lines are not collapsed, even identical ones: a
 * change's review status follows the event, not its content (see "a new change
 * starts unreviewed even when an identical one was reviewed").
 */
export function collapseDuplicates(views: readonly ConnectorChangeView[]): ConnectorChangeView[] {
  const out: ConnectorChangeView[] = [];
  const last = new Map<string, { key: string; index: number }>();
  for (const v of views) {
    if (v.review !== 'baseline') {
      last.delete(v.mcp);
      out.push(v);
      continue;
    }
    const key = duplicateKey(v);
    const prev = last.get(v.mcp);
    if (prev !== undefined && prev.key === key) {
      if (out[prev.index]!.review_status !== 'reviewed' && v.review_status === 'reviewed') {
        out[prev.index] = v;
      }
      continue;
    }
    last.set(v.mcp, { key, index: out.length });
    out.push(v);
  }
  return out;
}

/** Either format, or null when the line is neither. */
export function viewOfLine(line: string): ConnectorChangeView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return fromNativeLine(parsed) ?? fromLegacyLine(parsed);
}

/**
 * Applies the review markers to the changes they point at.
 *
 * Markers are applied in timestamp order, so the last one wins and the history
 * reads forward. A marker whose target is not in the set is dropped, not
 * guessed at: it may point at a change in a purged session file, and inventing
 * a row for it would fabricate evidence.
 */
export function foldReviewStatus(
  views: readonly ConnectorChangeView[],
  markers: readonly { ts: string; target_event_id: string; from: ReviewStatus; to: ReviewStatus }[],
): ConnectorChangeView[] {
  const byId = new Map(views.map((v) => [v.event_id, { ...v, review_history: [...v.review_history] }]));
  const ordered = [...markers].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const m of ordered) {
    const v = byId.get(m.target_event_id);
    if (v === undefined) continue;
    v.review_history.push({ ts: m.ts, from: m.from, to: m.to });
    v.review_status = m.to;
  }
  return views.map((v) => byId.get(v.event_id) ?? v);
}

/** A review marker line, or null. */
export function reviewMarkerOfLine(line: string): {
  ts: string;
  target_event_id: string;
  from: ReviewStatus;
  to: ReviewStatus;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isReviewStatusChangedEvent(parsed)) return null;
  return {
    ts: parsed.ts,
    target_event_id: parsed.target_event_id,
    from: parsed.from === 'reviewed' ? 'reviewed' : 'unreviewed',
    to: parsed.to,
  };
}

type ReviewMarker = { ts: string; target_event_id: string; from: ReviewStatus; to: ReviewStatus };

/** What one trail file contributes, before any cross-file step (sort, fold,
 *  collapse, mcp filter). Views here are FINAL for the file — reference notes
 *  already attached — and must never be mutated afterwards: the cache shares
 *  them between passes. */
export interface ChangesFileParse {
  views: ConnectorChangeView[];
  markers: ReviewMarker[];
  notified: string[];
}

const EMPTY_PARSE: ChangesFileParse = { views: [], markers: [], notified: [] };

/** One file's content → its views, review markers and notification targets. */
export function parseChangesFile(content: string): ChangesFileParse {
  // Cheap pre-filter: most session files carry neither format.
  if (
    !content.includes(CONNECTOR_CHANGE_TYPE) &&
    !content.includes(LEGACY_CATEGORY) &&
    !content.includes(REVIEW_STATUS_CHANGED_TYPE) &&
    !content.includes(OAUTH_AUTHORIZED_TYPE) &&
    !content.includes(CHANGE_NOTIFIED_TYPE)
  ) {
    return EMPTY_PARSE;
  }
  const views: ConnectorChangeView[] = [];
  const markers: ReviewMarker[] = [];
  const notified: string[] = [];
  // A login process writes its reference note right before its
  // oauth_authorized line (write_failed right after), all in its own
  // session. Both pending slots hold ONE entry and are cleared when used or
  // when a line of another session shows up, so they never grow.
  let pendingNote: { session: string; note: NonNullable<AuthorizationView['reference_note']> } | null = null;
  // A login that is not a row by itself, kept in case a write_failed /
  // kept_newer note right after it makes it one.
  let pendingLogin: { session: string; parsed: Record<string, unknown> } | null = null;
  let oauthSession: string | null = null;
  const oauthRowOfSession = new Map<string, ConnectorChangeView>();
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    const marker = reviewMarkerOfLine(line);
    if (marker !== null) {
      markers.push(marker);
      continue;
    }
    if (line.includes(OAUTH_AUTHORIZED_TYPE) || line.includes(OAUTH_REFERENCE_TYPE) || line.includes(CHANGE_NOTIFIED_TYPE)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const target = notifiedTargetOf(parsed);
      if (target !== null) {
        notified.push(target);
        continue;
      }
      const session = isRecord(parsed) && typeof parsed['session'] === 'string' ? parsed['session'] : '';
      if (session !== oauthSession) {
        oauthSession = session;
        pendingNote = null;
        pendingLogin = null;
      }
      const ref = referenceNoteOf(parsed);
      if (ref !== null) {
        const row = oauthRowOfSession.get(ref.session);
        if (row?.authorization !== undefined) {
          row.authorization.reference_note = ref.note;
        } else if (pendingLogin !== null && pendingLogin.session === ref.session) {
          // The note that makes a no-change login worth a row.
          const late = fromOAuthLine(pendingLogin.parsed, ref.note);
          pendingLogin = null;
          if (late !== null) {
            oauthRowOfSession.set(ref.session, late);
            views.push(late);
          }
        } else {
          pendingNote = { session: ref.session, note: ref.note };
        }
        continue;
      }
      if (isRecord(parsed) && parsed['type'] === OAUTH_AUTHORIZED_TYPE) {
        const note = pendingNote !== null && pendingNote.session === session ? pendingNote.note : undefined;
        pendingNote = null;
        const oauthView = fromOAuthLine(parsed, note);
        if (oauthView === null) {
          pendingLogin = { session, parsed };
          continue;
        }
        pendingLogin = null;
        oauthRowOfSession.set(session, oauthView);
        views.push(oauthView);
        continue;
      }
    }
    const view = viewOfLine(line);
    if (view === null) continue;
    views.push(view);
  }
  return { views, markers, notified };
}

/**
 * Per-file cache of parseChangesFile, keyed by path and validated by size,
 * mtime and inode. The trail is append-only and nearly all of it sits in
 * session files that never change again, so a pass re-reads only what is new
 * or changed. ANY change re-reads the whole file — growth included: a file's
 * OAuth reference notes resolve across its lines, so a partial parse could
 * disagree with a full one. A truncated or replaced file (smaller, or another
 * inode) is therefore re-read like any other change. A file gone from the
 * listing (retention) leaves the cache on the next pass.
 */
export interface ChangesFileCache {
  /** Files re-read by the last pass (for tests and measurement). */
  lastReads(): readonly string[];
  /** Records a line we appended ourselves to a cached file, so the next pass
   *  does not re-read it. Applied only when the file grew by exactly those
   *  bytes since its cached state; otherwise the entry is dropped and the
   *  next pass re-reads the file. */
  noteAppended(path: string, appendedBytes: number, marker: ReviewMarker): Promise<void>;
  /** @internal used by readConnectorChanges. */
  entries: Map<string, { size: number; mtimeMs: number; ino: number; parse: ChangesFileParse }>;
  /** @internal */
  reads: string[];
}

export function createChangesFileCache(): ChangesFileCache {
  const cache: ChangesFileCache = {
    entries: new Map(),
    reads: [],
    lastReads: () => cache.reads,
    async noteAppended(path, appendedBytes, marker) {
      const entry = cache.entries.get(path);
      if (entry === undefined) return;
      try {
        const st = await stat(path);
        if (st.ino === entry.ino && st.size === entry.size + appendedBytes) {
          cache.entries.set(path, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            ino: st.ino,
            parse: { ...entry.parse, markers: [...entry.parse.markers, marker] },
          });
          return;
        }
      } catch {
        // Fall through: drop the entry.
      }
      cache.entries.delete(path);
    },
  };
  return cache;
}

/**
 * Every connector change in the trail, newest first.
 *
 * Read on demand like the baseline history, not folded into the 2s audit poll:
 * these feed a view the user opens, and keeping them off that path is what
 * guarantees they can never reach a counter by accident. With a cache, only
 * new or changed files are read; the result is the same as a full read.
 */
export async function readConnectorChanges(
  dir: string,
  opts: { mcp?: string; limit?: number; cache?: ChangesFileCache } = {},
): Promise<ConnectorChangeView[]> {
  const limit = opts.limit ?? 500;
  const cache = opts.cache;
  if (cache !== undefined) cache.reads = [];
  let files: string[];
  try {
    files = await listJsonlFiles(dir);
  } catch {
    return [];
  }
  const parses: ChangesFileParse[] = [];
  const seen = new Set<string>();
  for (const name of files) {
    const path = join(dir, name);
    seen.add(path);
    if (cache !== undefined) {
      let st;
      try {
        st = await stat(path);
      } catch {
        cache.entries.delete(path);
        continue;
      }
      const hit = cache.entries.get(path);
      if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) {
        parses.push(hit.parse);
        continue;
      }
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        cache.entries.delete(path);
        continue; // an unreadable session file must not lose the others
      }
      cache.reads.push(name);
      const parse = parseChangesFile(content);
      // The stat taken BEFORE the read keys the entry: a write landing during
      // the read leaves the key stale, so the next pass re-reads — never the
      // reverse (a fresh key over content that missed the write).
      cache.entries.set(path, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, parse });
      parses.push(parse);
      continue;
    }
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue; // an unreadable session file must not lose the others
    }
    parses.push(parseChangesFile(content));
  }
  if (cache !== undefined) {
    for (const key of [...cache.entries.keys()]) if (!seen.has(key)) cache.entries.delete(key);
  }
  return aggregateChanges(parses, opts.mcp, limit);
}

/** The cross-file steps, on parses that are never mutated: mcp filter, sort,
 *  notified marks (copies), fold of the review markers (copies), collapse,
 *  cap. */
function aggregateChanges(parses: readonly ChangesFileParse[], mcp: string | undefined, limit: number): ConnectorChangeView[] {
  const out: ConnectorChangeView[] = [];
  const markers: ReviewMarker[] = [];
  const notified = new Set<string>();
  for (const p of parses) {
    for (const v of p.views) if (mcp === undefined || v.mcp === mcp) out.push(v);
    markers.push(...p.markers);
    for (const id of p.notified) notified.add(id);
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  const marked = out.map((v) => (notified.has(v.event_id) ? { ...v, notified: true } : v));
  // Fold BEFORE the cap: a marker written today may point at a change far down
  // the list, and slicing first would silently lose it. Collapse after the
  // fold, so a reviewed duplicate can win.
  return collapseDuplicates(foldReviewStatus(marked, markers)).slice(0, limit);
}
