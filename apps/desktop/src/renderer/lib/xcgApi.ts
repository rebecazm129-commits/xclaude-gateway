import type { HealthResult, RepairResult, SelfTestReport } from '@xcg/shared';
import type {
  AddRemoteResult,
  ConnectResult,
  InstallResult,
  RemoveRemoteResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';
import type { EnrichableEvent } from '../../shared/types.js';

export interface XcgApi {
  listDetections(): Promise<EnrichableEvent[]>;
  configStatus(): Promise<StatusResult>;
  configInstall(mode: 'dry-run' | 'yes'): Promise<InstallResult>;
  configUninstall(mode: 'dry-run' | 'yes'): Promise<UninstallResult>;
  configAddRemote(name: string, url: string): Promise<AddRemoteResult>;
  configRemoveRemote(name: string): Promise<RemoveRemoteResult>;
  configConnect(name: string, url: string): Promise<ConnectResult>;
  validateHealth(): Promise<HealthResult>;
  repairWraps(): Promise<RepairResult>;
  runSelfTest(): Promise<SelfTestReport>;
  openAuditFolder(): Promise<void>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
