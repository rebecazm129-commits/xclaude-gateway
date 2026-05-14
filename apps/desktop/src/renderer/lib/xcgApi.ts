import type { DetectionEvent } from '../../shared/types.js';

export interface XcgApi {
  listDetections(): Promise<DetectionEvent[]>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
