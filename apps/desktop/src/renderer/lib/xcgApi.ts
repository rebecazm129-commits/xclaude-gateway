import type { HealthResult, RepairResult, SelfTestReport } from '@xcg/shared';
import type {
  AddRemoteResult,
  ConnectResult,
  InstallResult,
  IsConnectedResult,
  RemoveRemoteResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';
import type {
  ToolCount,
  CchookInstallResult,
  CchookStatus,
  DetectionListResult,
  DetectionCursor,
  DetectionDetail,
  DetectionFilter,
  DetectionPageResult,
  AuditExportFormat,
  AuditExportResult,
  PurgeMode,
  RetentionSetModeResult,
  RetentionStatus,
  SeedClientResult,
} from '../../shared/types.js';

/** Mirrors main/baseline-history.ts. Declared here rather than imported so the
 *  renderer keeps no dependency on a main-process module. */
export interface BaselineHistoryEntry {
  ts: string;
  mcp: string;
  event:
    | 'section_initialized'
    | 'migrated'
    | 'projection_migrated'
    | 'reseeded'
    | 'snapshot_incomplete';
  section?: string;
  reason?: string;
  coverageExpanded?: string[];
  fromVersion?: number;
  toVersion?: number;
}

/** Mirrors main/connector-changes.ts. Declared here rather than imported so the
 *  renderer keeps no dependency on a main-process module. */
export interface ConnectorChangeEntryView {
  kind:
    | 'item_added'
    | 'item_removed'
    | 'description_changed'
    | 'surface_added'
    | 'surface_removed'
    | 'schema_changed'
    | 'returned_to_seen_state';
  target: string;
  path?: string;
}

export interface ConnectorFindingView {
  rule_id: string;
  rule_version: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: { target?: string; path?: string; rule?: string; codepoint?: string; count?: number };
}

export type AttentionView =
  | { level: 'normal' }
  | { level: 'review_recommended'; heuristic_id: string; heuristic_version: number };

/** An authorization row's before → now (main/connector-changes.ts). */
export interface AuthorizationView {
  authorization_server: { before: string | null; now: string };
  authorization_server_source: 'protected_resource_metadata' | 'server_url_fallback';
  scopes: { before: string[] | null; now: string[]; added: string[]; removed: string[] };
  requested_scopes: string[];
  scope_source: 'token_response' | 'assumed_requested';
  resource: { before: string | null; now: string | null; changed: boolean };
  first_login: boolean;
  previous_login_at: string | null;
  reference_note?: 'initialized' | 'reseeded' | 'kept_newer' | 'write_failed';
}

export interface ConnectorChangeView {
  event_id: string;
  ts: string;
  mcp: string;
  section: 'tools' | 'resources' | 'resource_templates' | 'prompts' | 'discovery' | 'authorization';
  snapshot: { before: string | null; after: string } | null;
  changes: ConnectorChangeEntryView[];
  findings: ConnectorFindingView[];
  attention: AttentionView;
  review_status: 'unreviewed' | 'reviewed';
  review_history: { ts: string; from: string; to: string }[];
  source_format?: 'tool_manifest_changed_v1';
  /** A catalog review: the findings are about the definition as it stands. */
  review?: 'baseline';
  reviewed_with?: Record<string, number>;
  /** Previous and new text of the descriptions that moved. Native events only:
   *  a historical one has no snapshot to diff against. */
  descriptionDiff?: { target: string; before: string; after: string }[];
  /** Authorization rows only. */
  authorization?: AuthorizationView;
  notified?: boolean;
}

export interface XcgApi {
  listDetections(): Promise<DetectionListResult>;
  listDetectionPage(params: {
    filter: DetectionFilter;
    limit: number;
    cursor: DetectionCursor | null;
  }): Promise<DetectionPageResult>;
  detectionDetail(id: string): Promise<DetectionDetail | null>;
  exportAudit(filter: DetectionFilter, format: AuditExportFormat): Promise<AuditExportResult>;
  retentionStatus(): Promise<RetentionStatus>;
  retentionSetMode(mode: PurgeMode): Promise<RetentionSetModeResult>;
  retentionEstimate(mode: PurgeMode): Promise<number>;
  configStatus(): Promise<StatusResult>;
  configInstall(mode: 'dry-run' | 'yes', only?: string): Promise<InstallResult>;
  configUninstall(mode: 'dry-run' | 'yes'): Promise<UninstallResult>;
  configAddRemote(name: string, url: string): Promise<AddRemoteResult>;
  configRemoveRemote(name: string): Promise<RemoveRemoteResult>;
  configConnect(name: string, url: string, scope?: string): Promise<ConnectResult>;
  configIsConnected(name: string): Promise<IsConnectedResult>;
  configHasCredentials(name: string): Promise<boolean>;
  configHasClient(name: string): Promise<boolean>;
  /** Seed one BYO OAuth client for several connectors; the secret is optional
   *  (omitted from the stored JSON for public-PKCE clients). */
  configSeedClient(names: string[], clientId: string, clientSecret?: string): Promise<SeedClientResult>;
  configToolCount(name: string): Promise<ToolCount | null>;
  /** Claude Code auditing status (detect + hook + ingester + spool backlog). */
  cchookStatus(): Promise<CchookStatus>;
  /** Register the capture hook in ~/.claude/settings.json (idempotent). */
  cchookInstall(): Promise<CchookInstallResult>;
  /** Bring an existing hook install up to date (new events, async, --event).
   *  Only our own entries change; Claude Code must be restarted to load it. */
  cchookUpdate(): Promise<CchookInstallResult>;
  /** "Not now": hide the update notice until the set of pending changes differs. */
  cchookNotNow(key: string): Promise<void>;
  /** Dismiss the "events were not recorded" notice (spool cap). */
  cchookDismissDropped(): Promise<void>;
  /** Surgically remove our hook entries from ~/.claude/settings.json. */
  cchookUninstall(): Promise<CchookInstallResult>;
  /** Dismiss the hook-removed notice (clears the persisted pendingNotice). */
  cchookDismissVanished(): Promise<void>;
  validateHealth(): Promise<HealthResult>;
  repairWraps(): Promise<RepairResult>;
  runSelfTest(): Promise<SelfTestReport>;
  openAuditFolder(): Promise<void>;
  /** App version (package.json), for the Settings About section. */
  appVersion(): Promise<string>;
  /** Baseline lifecycle for one connector's card. These events describe what
   *  the AUDITOR did to its own state and never appear as detections. */
  baselineHistory?(mcp: string): Promise<BaselineHistoryEntry[]>;
  /** Connector surface changes, both formats, newest first. Optional: a
   *  preload from an older build does not expose it, and the renderer must not
   *  assume it does. */
  connectorChanges?(mcp?: string): Promise<ConnectorChangeView[]>;
  /** Appends an app.review_status_changed marker pointing at one change. */
  setReviewStatus?(eventId: string, to: 'reviewed' | 'unreviewed'): Promise<void>;
  /** Exports the given changes as the versioned document. */
  exportChanges?(eventIds: string[]): Promise<AuditExportResult>;
  /** Current OS login-item state. Read on every panel open — never cached:
   *  macOS System Settings can change it behind the app's back. */
  openAtLogin(): Promise<boolean>;
  /** Sets the login item and returns what the OS holds AFTERWARDS, which is not
   *  necessarily what was requested. */
  setOpenAtLogin(value: boolean): Promise<boolean>;
  /** Open an http(s) URL in the system browser (never navigates the renderer). */
  openExternalUrl(url: string): Promise<void>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
