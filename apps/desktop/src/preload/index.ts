import { contextBridge, ipcRenderer } from 'electron';

import type { DetectionEvent } from '../shared/types.js';

contextBridge.exposeInMainWorld('xcg', {
  listDetections: (): Promise<DetectionEvent[]> => ipcRenderer.invoke('detection:list'),
});
