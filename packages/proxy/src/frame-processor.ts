// FrameProcessor — transforms an MCP JSON-RPC frame into one or more
// EventBody emissions. For request frames, runs the detection chain and
// emits one body per DetectorOutput (Milestone 3 decision 3). For other
// frame kinds, emits a single body — detection sub-object is absent.

import type { DetectionEngine } from './detection/engine.js';
import type { Direction, EventBody } from './events.js';
import type { InflightTracker } from './latency.js';
import type { ClassifiedFrame } from './parser.js';
import { buildDetectorInput } from './detection/engine.js';
import type { AsyncDetector } from './detection/types.js';
import { elapsedUs } from './timing.js';

export interface FrameProcessorDeps {
  tracker: InflightTracker;
  engine: DetectionEngine;
  mcp: string;
  session: string;
  asyncDetector?: AsyncDetector;
}

export type FrameProcessor = (
  frame: ClassifiedFrame,
  direction: Direction,
  bytes: number,
  line: string,
  tsObservedNs: bigint,
  tsWallMs: number,
) => EventBody[];

export function createFrameProcessor(deps: FrameProcessorDeps): FrameProcessor {
  return (frame, direction, bytes, line, tsObservedNs, tsWallMs) => {
    switch (frame.kind) {
      case 'request': {
        deps.tracker.trackRequest(direction, frame.id, tsWallMs);
        const envelope = {
          payload: frame.params,
          mcp: deps.mcp,
          method: frame.method,
          direction,
          sessionId: deps.session,
        };
        const detections = deps.engine.detect(envelope);
        if (deps.asyncDetector !== undefined) {
          deps.asyncDetector.enqueue(buildDetectorInput(envelope), frame.id);
        }
        const overheadUs = elapsedUs(tsObservedNs);
        return detections.map((detection) => ({
          type: 'mcp.request',
          direction,
          rpcId: frame.id,
          method: frame.method,
          params: frame.params,
          bytes,
          overheadUs,
          detection,
        }));
      }
      case 'response': {
        const latencyMs = deps.tracker.matchResponse(direction, frame.id, tsWallMs);
        return [
          {
            type: 'mcp.response',
            direction,
            rpcId: frame.id,
            bytes,
            overheadUs: elapsedUs(tsObservedNs),
            ...('result' in frame ? { result: frame.result } : {}),
            ...('error' in frame ? { error: frame.error } : {}),
            ...(latencyMs !== undefined ? { latencyMs } : {}),
          },
        ];
      }
      case 'notification':
        return [
          {
            type: 'mcp.notification',
            direction,
            method: frame.method,
            params: frame.params,
            bytes,
            overheadUs: elapsedUs(tsObservedNs),
          },
        ];
      case 'parse_error':
        return [
          {
            type: 'proxy.error',
            kind: 'parse_error',
            message: `MCP frame parse error: ${frame.reason}`,
            reason: frame.reason,
            frameSnippet: line.length > 256 ? line.slice(0, 256) : line,
          },
        ];
    }
  };
}
