// The facts model for connector changes.
//
// WHY A SEPARATE MODEL. `tool_manifest_changed` conflated two different
// statements: "the connector changed" and "that change is a risk". Four months
// of production say the first happens 217 times and the second 20 — so the
// conflation buried 20 real signals under 197 rows the user had no way to
// triage. A connector_change now STATES the change; findings, if any, say what
// a security rule made of it.
//
// Three vocabularies, deliberately kept apart:
//   changes[]  — what moved. No severity, ever. A fact.
//   findings[] — what a SECURITY rule matched. Carries its own severity, plus
//                the id and version of the rule, so a judgement stays
//                reproducible after the rule changes.
//   attention  — a heuristic's opinion that a human should look. Also carries
//                an id and a version, for exactly the same reason: a heuristic
//                that silently changes its threshold makes every past
//                "review_recommended" uninterpretable.
//
// review_status is NOT here. It lives in separate app.review_status_changed
// lines and is folded at read time — the trail is append-only, and an event
// that could be edited after the fact is not evidence.

export const CONNECTOR_CHANGE_TYPE = 'mcp.connector_change';
export const REVIEW_STATUS_CHANGED_TYPE = 'app.review_status_changed';

/** Version of the exported document format (not of any rule or heuristic). */
export const CHANGES_EXPORT_SCHEMA_VERSION = 1;

/**
 * The part of a connector's surface a change belongs to.
 *
 * Mirrors the v2 baseline's SectionName (proxy/detection/manifest-v2.ts). The
 * two are reconciled when the store starts emitting these events; until then
 * they are kept in step by hand, and that is the only reason this comment
 * exists.
 */
export type ConnectorSection =
  | 'tools'
  | 'resources'
  | 'resource_templates'
  | 'prompts'
  | 'discovery';

/** What moved. Purely descriptive — none of these implies risk. */
export type ChangeKind =
  | 'item_added'
  | 'item_removed'
  | 'description_changed'
  | 'surface_added'
  | 'surface_removed'
  | 'schema_changed'
  | 'returned_to_seen_state';

export interface ConnectorChangeEntry {
  kind: ChangeKind;
  /** Tool / resource / prompt name, or the discovery field. */
  target: string;
  /** JSON path within the item, when the change is narrower than the item. */
  path?: string;
}

/** Stable identifier of a security rule. Adding one is additive; changing what
 *  an existing one matches requires bumping its version. */
export type RuleId =
  | 'sensitive_param_added'
  | 'sensitive_path_reference'
  | 'injection_marker'
  | 'hidden_characters';

export interface RuleEvidence {
  target?: string;
  path?: string;
  /** Which shape inside the rule matched (ssh_private_key, dotenv…). */
  rule?: string;
  codepoint?: string;
  count?: number;
}

export interface ConnectorFinding {
  rule_id: RuleId;
  rule_version: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: RuleEvidence;
}

/**
 * Whether a human should look.
 *
 * A union rather than a flag plus optional fields: raising attention without
 * naming the heuristic that raised it is not representable.
 */
export type Attention =
  | { level: 'normal' }
  | { level: 'review_recommended'; heuristic_id: string; heuristic_version: number };

/** Hashes only — the content itself stays in the v2 baseline, not in the trail. */
export interface SnapshotRef {
  before: string | null;
  after: string;
}

export interface ConnectorChangeEvent {
  v: 1;
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: typeof CONNECTOR_CHANGE_TYPE;
  section: ConnectorSection;
  snapshot: SnapshotRef | null;
  catalog?: { before: number; after: number };
  changes: ConnectorChangeEntry[];
  findings: ConnectorFinding[];
  attention: Attention;
}

export type ReviewStatus = 'unreviewed' | 'reviewed';

export interface ReviewStatusChangedEvent {
  v: 1;
  id: string;
  ts: string;
  type: typeof REVIEW_STATUS_CHANGED_TYPE;
  target_event_id: string;
  from: ReviewStatus;
  to: ReviewStatus;
}

// --- narrowing -------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function isConnectorChangeEvent(value: unknown): value is ConnectorChangeEvent {
  if (!isRecord(value) || value['type'] !== CONNECTOR_CHANGE_TYPE) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['ts'] === 'string' &&
    typeof value['mcp'] === 'string' &&
    Array.isArray(value['changes']) &&
    Array.isArray(value['findings'])
  );
}

export function isReviewStatusChangedEvent(value: unknown): value is ReviewStatusChangedEvent {
  if (!isRecord(value) || value['type'] !== REVIEW_STATUS_CHANGED_TYPE) return false;
  return (
    typeof value['target_event_id'] === 'string' &&
    (value['to'] === 'reviewed' || value['to'] === 'unreviewed') &&
    typeof value['ts'] === 'string'
  );
}

// --- export document -------------------------------------------------------

export interface ChangesExportEvent {
  event_id: string;
  event_type: 'connector_change';
  ts: string;
  mcp: string;
  section: ConnectorSection;
  snapshot: SnapshotRef | null;
  changes: ConnectorChangeEntry[];
  findings: ConnectorFinding[];
  attention: Attention;
  /** Folded from the review_status_changed lines; never stored on the event. */
  review_status: ReviewStatus;
  review_history: { ts: string; from: ReviewStatus; to: ReviewStatus }[];
  /** Set only on rows reconstructed from pre-model trail lines, so a consumer
   *  does not read a missing snapshot as a defect. */
  source_format?: 'tool_manifest_changed_v1';
}

export interface ChangesExport {
  schema_version: typeof CHANGES_EXPORT_SCHEMA_VERSION;
  exported_at: string;
  generator: { app: string; version: string };
  events: ChangesExportEvent[];
}
