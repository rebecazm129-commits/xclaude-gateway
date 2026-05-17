import type { EnrichableEvent } from '../../shared/types.js';

export interface XcgApi {
  listDetections(): Promise<EnrichableEvent[]>;
}

declare global {
  interface Window {
    xcg: XcgApi;
  }
}
