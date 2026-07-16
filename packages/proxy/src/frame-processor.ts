// FrameProcessor — transforms an MCP JSON-RPC frame into one or more
// EventBody emissions. For request frames, runs the detection chain and
// emits one body per DetectorOutput (Milestone 3 decision 3). For other
// frame kinds, emits a single body — detection sub-object is absent.

import type { DetectionEngine } from './detection/engine.js';
import type { Direction, EventBody } from './events.js';
import { attachMaskSecrets } from './events.js';
import { invertDirection, type InflightTracker } from './latency.js';
import type { ClassifiedFrame } from './parser.js';
import { buildDetectorInput } from './detection/engine.js';
import {
  credentialDetected,
  credentialMatches,
  dataExportWarning,
  emailSendWarning,
  piiStructured,
  promptInjection,
} from './detection/detectors/index.js';
import type { AsyncDetector, Detector, DetectorInput } from './detection/types.js';
import type { ManifestStore } from './detection/manifest.js';
import { elapsedUs } from './timing.js';

export interface FrameProcessorDeps {
  tracker: InflightTracker;
  engine: DetectionEngine;
  mcp: string;
  session: string;
  asyncDetector?: AsyncDetector;
  // Tool-manifest baseline store. Optional: when absent, tools/list responses
  // are not diffed (no tool_manifest_changed detection).
  manifestStore?: ManifestStore;
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
        const events: EventBody[] = detections.map((detection) => ({
          type: 'mcp.request',
          direction,
          rpcId: frame.id,
          method: frame.method,
          params: frame.params,
          bytes,
          overheadUs,
          detection,
        }));
        // Credential masking: if a credential fired, redact its value from
        // EVERY emitted request event (they share the same params) before the
        // sink persists them. Scan only when the detector already flagged one.
        if (detections.some((d) => d.category === 'credential_detected')) {
          const secrets = credentialMatches(buildDetectorInput(envelope).paramsJson);
          for (const ev of events) attachMaskSecrets(ev, secrets);
        }
        return events;
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
              // Inbound credential in the result text → mask it out of the
              // persisted mcp.response (events[0], which carries the raw
              // result). Reuse the same scan the detector just did — no extra
              // pass, no fragile pre-filter.
              if (out.category === 'credential_detected') {
                attachMaskSecrets(events[0]!, credentialMatches(text));
              }
              // data_export_warning is downgraded to 'low' INBOUND only: export
              // language inside a result is a possible tool-poisoning signal but
              // far less actionable than an outbound export command, and it
              // false-positives on ordinary document text (Drive contentSnippets
              // with "Save the file as: …", 07/07). Kept rather than dropped
              // because prompt_injection's patterns do NOT cover direct export
              // instructions injected in results (verified 06-07/07). The
              // request path keeps the detector's own severity ('medium').
              const severity = out.category === 'data_export_warning' ? 'low' : out.severity;
              const detection = { ...out, severity, findings: out.findings.map((f) => ({ ...f, location: 'result' })) };
              events.push({ type: 'mcp.detection_enrichment', rpcId: frame.id, direction, detection, overheadUs });
            }
          }
        }
        // Tool-poisoning: diff the tools/list manifest against the persisted
        // per-connector baseline. Separate from the tools/call block above; the
        // raw mcp.response (with result.tools) is unaffected. Hash runs on the
        // RAW frame.result, before EventSink's leaf truncation. A change emits
        // ONE mcp.detection_enrichment with the response's direction (so it lands
        // as its own row, uncorrelated to the tools/list request).
        if (deps.manifestStore !== undefined && reqMethod === 'tools/list' && 'result' in frame) {
          const outcome = deps.manifestStore.checkAndUpdate(deps.mcp, frame.result);
          if (outcome.changed && outcome.detection !== undefined) {
            events.push({
              type: 'mcp.detection_enrichment',
              rpcId: frame.id,
              direction,
              detection: outcome.detection,
              overheadUs: elapsedUs(tsObservedNs),
            });
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
