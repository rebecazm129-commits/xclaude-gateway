import { contextBridge, ipcRenderer } from 'electron';

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
  AuditExportFormat,
  AuditExportResult,
  PurgeMode,
  RetentionSetModeResult,
  RetentionStatus,
  SeedClientResult,
} from '../shared/types.js';

contextBridge.exposeInMainWorld('xcg', {
  listDetections: (): Promise<DetectionListResult> => ipcRenderer.invoke('detection:list'),
  listDetectionPage: (params: {
    filter: DetectionFilter;
    limit: number;
    cursor: DetectionCursor | null;
  }): Promise<DetectionPageResult> => ipcRenderer.invoke('detection:page', params),
  detectionDetail: (id: string): Promise<DetectionDetail | null> =>
    ipcRenderer.invoke('detection:detail', { id }),
  exportAudit: (filter: DetectionFilter, format: AuditExportFormat): Promise<AuditExportResult> =>
    ipcRenderer.invoke('audit:export', { filter, format }),
  retentionStatus: (): Promise<RetentionStatus> => ipcRenderer.invoke('retention:status'),
  retentionSetMode: (mode: PurgeMode): Promise<RetentionSetModeResult> =>
    ipcRenderer.invoke('retention:set-mode', { mode }),
  retentionEstimate: (mode: PurgeMode): Promise<number> =>
    ipcRenderer.invoke('retention:estimate', { mode }),
  configStatus: (): Promise<StatusResult> => ipcRenderer.invoke('config:status'),
  configInstall: (mode: 'dry-run' | 'yes', only?: string): Promise<InstallResult> =>
    ipcRenderer.invoke('config:install', mode, only),
  configUninstall: (mode: 'dry-run' | 'yes'): Promise<UninstallResult> =>
    ipcRenderer.invoke('config:uninstall', mode),
  configAddRemote: (name: string, url: string): Promise<AddRemoteResult> =>
    ipcRenderer.invoke('config:add-remote', { name, url }),
  configRemoveRemote: (name: string): Promise<RemoveRemoteResult> =>
    ipcRenderer.invoke('config:remove-remote', { name }),
  configConnect: (name: string, url: string, scope?: string): Promise<ConnectResult> =>
    ipcRenderer.invoke('config:connect', { name, url, scope }),
  configIsConnected: (name: string): Promise<IsConnectedResult> =>
    ipcRenderer.invoke('config:is-connected', { name }),
  configHasCredentials: (name: string): Promise<boolean> =>
    ipcRenderer.invoke('config:has-credentials', { name }),
  configHasClient: (name: string): Promise<boolean> =>
    ipcRenderer.invoke('config:has-client', { name }),
  configSeedClient: (names: string[], clientId: string, clientSecret?: string): Promise<SeedClientResult> =>
    ipcRenderer.invoke('config:seed-client', { names, clientId, clientSecret }),
  configToolCount: (name: string): Promise<ToolCount | null> =>
    ipcRenderer.invoke('config:tool-count', { name }),
  validateHealth: (): Promise<HealthResult> => ipcRenderer.invoke('system:health'),
  repairWraps: (): Promise<RepairResult> => ipcRenderer.invoke('system:repair-wraps'),
  runSelfTest: (): Promise<SelfTestReport> => ipcRenderer.invoke('system:self-test:run'),
  openAuditFolder: (): Promise<void> => ipcRenderer.invoke('system:open-audit-folder'),
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('system:open-external', url),
});
