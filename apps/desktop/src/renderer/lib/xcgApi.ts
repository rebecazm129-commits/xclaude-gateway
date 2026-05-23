import type { HealthResult, RepairResult } from '@xcg/shared';
import type {
  InstallResult,
  StatusResult,
  UninstallResult,
} from '@xcg/shared/config';
import type { EnrichableEvent } from '../../shared/types.js';

export interface XcgApi {
  listDetections(): Promise<EnrichableEvent[]>;
  configStatus(): Promise<StatusResult>;
  configInstall(mode: 'dry-run' | 'yes'): Promise<InstallResult>;
  configUninstall(mode: 'dry-run' | 'yes'): Promise<UninstallResult>;
  validateHealth(): Promise<HealthResult>;
  repairWraps(): Promise<RepairResult>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
