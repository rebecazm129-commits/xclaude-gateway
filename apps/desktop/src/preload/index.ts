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
import type { EnrichableEvent } from '../shared/types.js';

contextBridge.exposeInMainWorld('xcg', {
  listDetections: (): Promise<EnrichableEvent[]> => ipcRenderer.invoke('detection:list'),
  configStatus: (): Promise<StatusResult> => ipcRenderer.invoke('config:status'),
  configInstall: (mode: 'dry-run' | 'yes'): Promise<InstallResult> =>
    ipcRenderer.invoke('config:install', mode),
  configUninstall: (mode: 'dry-run' | 'yes'): Promise<UninstallResult> =>
    ipcRenderer.invoke('config:uninstall', mode),
  configAddRemote: (name: string, url: string): Promise<AddRemoteResult> =>
    ipcRenderer.invoke('config:add-remote', { name, url }),
  configRemoveRemote: (name: string): Promise<RemoveRemoteResult> =>
    ipcRenderer.invoke('config:remove-remote', { name }),
  configConnect: (name: string, url: string): Promise<ConnectResult> =>
    ipcRenderer.invoke('config:connect', { name, url }),
  configIsConnected: (name: string): Promise<IsConnectedResult> =>
    ipcRenderer.invoke('config:is-connected', { name }),
  validateHealth: (): Promise<HealthResult> => ipcRenderer.invoke('system:health'),
  repairWraps: (): Promise<RepairResult> => ipcRenderer.invoke('system:repair-wraps'),
  runSelfTest: (): Promise<SelfTestReport> => ipcRenderer.invoke('system:self-test:run'),
  openAuditFolder: (): Promise<void> => ipcRenderer.invoke('system:open-audit-folder'),
});
