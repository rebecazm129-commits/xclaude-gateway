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
