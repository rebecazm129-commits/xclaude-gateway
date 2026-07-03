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
  DetectionListResult,
  DetectionCursor,
  DetectionDetail,
  DetectionFilter,
  DetectionPageResult,
  PurgeMode,
  RetentionSetModeResult,
  RetentionStatus,
} from '../../shared/types.js';

export interface XcgApi {
  listDetections(): Promise<DetectionListResult>;
  listDetectionPage(params: {
    filter: DetectionFilter;
    limit: number;
    cursor: DetectionCursor | null;
  }): Promise<DetectionPageResult>;
  detectionDetail(id: string): Promise<DetectionDetail | null>;
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
  configToolCount(name: string): Promise<ToolCount | null>;
  validateHealth(): Promise<HealthResult>;
  repairWraps(): Promise<RepairResult>;
  runSelfTest(): Promise<SelfTestReport>;
  openAuditFolder(): Promise<void>;
  /** Open an http(s) URL in the system browser (never navigates the renderer). */
  openExternalUrl(url: string): Promise<void>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
