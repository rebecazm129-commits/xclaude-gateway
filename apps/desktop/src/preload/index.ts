import { contextBridge, ipcRenderer } from 'electron';

import type { HealthResult, RepairResult, SelfTestReport } from '@xcg/shared';
import type {
  InstallResult,
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
  validateHealth: (): Promise<HealthResult> => ipcRenderer.invoke('system:health'),
  repairWraps: (): Promise<RepairResult> => ipcRenderer.invoke('system:repair-wraps'),
  runSelfTest: (): Promise<SelfTestReport> => ipcRenderer.invoke('system:self-test:run'),
});
