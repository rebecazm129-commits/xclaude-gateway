import { contextBridge, ipcRenderer } from 'electron';

import type { EnrichableEvent } from '../shared/types.js';

contextBridge.exposeInMainWorld('xcg', {
  listDetections: (): Promise<EnrichableEvent[]> => ipcRenderer.invoke('detection:list'),
});
