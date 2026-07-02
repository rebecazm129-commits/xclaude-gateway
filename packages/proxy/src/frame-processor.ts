// FrameProcessor — transforms an MCP JSON-RPC frame into one or more
// EventBody emissions. For request frames, runs the detection chain and
// emits one body per DetectorOutput (Milestone 3 decision 3). For other
// frame kinds, emits a single body — detection sub-object is absent.

import type { DetectionEngine } from './detection/engine.js';
import type { Direction, EventBody } from './events.js';
import { invertDirection, type InflightTracker } from './latency.js';
import type { ClassifiedFrame } from './parser.js';
import { buildDetectorInput } from './detection/engine.js';
import {
  credentialDetected,
  dataExportWarning,
  emailSendWarning,
  piiStructured,
  promptInjection,
} from './detection/detectors/index.js';
import type { AsyncDetector, Detector, DetectorInput } from './detection/types.js';
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

// Slice 1: extract ONLY the textual content of a tools/call result —
// result.content[].text (type === 'text') + JSON.stringify(structuredContent).
// This is the surface scanned for credentials, not the whole result.
function extractResultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const parts: string[] = [];
  const content = (result as Record<string, unknown>)['content'];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text') {
        const text = (c as Record<string, unknown>)['text'];
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  const sc = (result as Record<string, unknown>)['structuredContent'];
  if (sc !== undefined) parts.push(JSON.stringify(sc));
  return parts.join('\n');
}

// Content detectors that run inline over the extracted tools/call result text.
// Multi-label, like the request side: each matching detector yields its own
// mcp.detection_enrichment. Order mirrors the request chain ACTIVE_DETECTORS
// (severity desc): credential, prompt_injection, email_send_warning,
// data_export_warning, pii_structured.
//
// NER (pii_detected) is deliberately EXCLUDED here: it is off-path/async and
// only enqueued on the request path (severity low; routing every connector
// result through the worker would add queue pressure for the least actionable
// signal). Inbound PII coverage is the checksum-backed pii_structured only.
//
// emailSendWarning has two branches, but only its TEXT branch (imperative
// send-language) can fire inbound: the inbound DetectorInput sets
// toolName: undefined (below), so the TOOL-NAME branch — email_send_tool /
// email_compose_tool, which classifies the CALLED tool's name — is inert.
// That is correct: a tool's *result* has no tool name to classify.
const CONTENT_DETECTORS: readonly Detector[] = [
  credentialDetected,
  promptInjection,
  emailSendWarning,
  dataExportWarning,
  piiStructured,
];

export function createFrameProcessor(deps: FrameProcessorDeps): FrameProcessor {
  // (key -> request method): the tracker pairs by latency only, not method, so
  // we keep our own map to know whether a response answered a tools/call. We
  // replicate InflightTracker's keying — `${direction}:${rpcId}` set on the
  // REQUEST's direction, looked up on `invertDirection(response.direction)` —
  // so a server→client and a client→client request with the same rpcId don't
  // collide. No TTL (mirrors InflightTracker): unmatched entries clear at
  // session end.
  const requestMethods = new Map<string, string>();
  return (frame, direction, bytes, line, tsObservedNs, tsWallMs) => {
    switch (frame.kind) {
      case 'request': {
        deps.tracker.trackRequest(direction, frame.id, tsWallMs);
        requestMethods.set(`${direction}:${frame.id}`, frame.method);
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
        // Pair with the originating request using the tracker's keying: the
        // request was tracked under its own direction; from the response we
        // invert. Mirrors InflightTracker.matchResponse.
        const reqKey = `${invertDirection(direction)}:${frame.id}`;
        const reqMethod = requestMethods.get(reqKey);
        requestMethods.delete(reqKey);
        const events: EventBody[] = [
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
        // Slice 1+2: classify credential leaks and prompt-injection in the
        // CONTENT of tools/call results. Inline regex content detectors; one
        // mcp.detection_enrichment PER matching detector (multi-label, like the
        // request side); findings remapped to location 'result'. No FP triage
        // here — capture-all stays; inbound-noise handling is deferred (Hito 5).
        if (reqMethod === 'tools/call' && 'result' in frame) {
          const text = extractResultText(frame.result);
          if (text.length > 0) {
            const input: DetectorInput = {
              envelope: { payload: text, mcp: deps.mcp, method: 'tools/call', direction, sessionId: deps.session },
              paramsJson: text,
              toolName: undefined,
            };
            const overheadUs = elapsedUs(tsObservedNs);
            for (const detect of CONTENT_DETECTORS) {
              const out = detect(input);
              if (!out) continue;
              const detection = { ...out, findings: out.findings.map((f) => ({ ...f, location: 'result' })) };
              events.push({ type: 'mcp.detection_enrichment', rpcId: frame.id, direction, detection, overheadUs });
            }
          }
        }
        return events;
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
