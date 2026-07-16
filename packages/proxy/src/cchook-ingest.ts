// cchook-ingest — PURE translation of captured Claude Code hook payloads into
// audit-trail envelopes (F1.2). No fs, no side effects: bytes in, Envelope[]
// out. The fs orchestration (spool readdir, session map, append, unlink) lives
// in the desktop ingester (apps/desktop/src/main/cchook-ingester.ts), which
// imports this module through the '@xcg/proxy/cchook-ingest' export.
//
// Synthesis contract (F1.2 v2, anchored on frame-processor verbatims):
//   PostToolUse        → mcp.request + mcp.response paired by rpcId=tool_use_id
//   PostToolUseFailure → mcp.request + mcp.response with `error` (0c variant)
//   SessionStart/other/unknown → one 'cc.event' line with the raw payload
//     (safe: the desktop reader ignores unknown types without breaking, 0e).
// Classification replicates the wrapper EXACTLY:
//   request  → detection inline on mcp.request; multi-label = one mcp.request
//              per detection (frame-processor emits detections.map(...), 0k).
//   response/failure text → one mcp.detection_enrichment PER matching detector,
//              direction = the response's ('server_to_client'), findings
//              remapped to location 'result', and data_export_warning
//              downgraded to 'low' INBOUND only (07/07 fix) — all three
//              mirroring the frame-processor inbound block (0h) verbatim.
//   Baseline tool_call_allowed only on the request (emitDetections); inbound
//   emits nothing when no detector fires, like the wrapper.

import { ACTIVE_DETECTORS } from './detection/detectors/index.js';
import { buildDetectorInput, emitDetections, runDetectors } from './detection/engine.js';
import type { DetectorInput, McpRequestEnvelope, RpcId } from './detection/types.js';
import type { Envelope } from './audit.js';

export { cchookSpoolDir } from './cchook-paths.js';

// --- tolerant parse -----------------------------------------------------------

export interface ParsedHookEvent {
  kind: 'hook';
  hookEventName: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  error?: string;
  isInterrupt?: boolean;
  promptId?: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  permissionMode?: string;
  durationMs?: number;
  toolUseId?: string;
  /** SessionStart: how the session began ('startup', 'resume', ...). */
  source?: string;
  /** SessionStart: model id. */
  model?: string;
  /** Every key we don't type, preserved verbatim (transcript_path, effort, ...). */
  extras: Record<string, unknown>;
  /** The full parsed payload, untouched (cc.event carries it). */
  raw: unknown;
}

export type ParsedHook = ParsedHookEvent | { kind: 'unknown'; raw: string };

const KNOWN_KEYS = new Set([
  'hook_event_name',
  'session_id',
  'tool_name',
  'tool_input',
  'tool_response',
  'error',
  'is_interrupt',
  'prompt_id',
  'agent_id',
  'agent_type',
  'cwd',
  'permission_mode',
  'duration_ms',
  'tool_use_id',
  'source',
  'model',
]);

export function parseHookPayload(bytes: Buffer | string): ParsedHook {
  const raw = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unknown', raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unknown', raw };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['hook_event_name'] !== 'string') return { kind: 'unknown', raw };

  const str = (k: string): string | undefined =>
    typeof obj[k] === 'string' ? (obj[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof obj[k] === 'number' && Number.isFinite(obj[k] as number) ? (obj[k] as number) : undefined;
  const bool = (k: string): boolean | undefined =>
    typeof obj[k] === 'boolean' ? (obj[k] as boolean) : undefined;

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v;
  }

  return {
    kind: 'hook',
    hookEventName: obj['hook_event_name'] as string,
    sessionId: str('session_id'),
    toolName: str('tool_name'),
    toolInput: 'tool_input' in obj ? obj['tool_input'] : undefined,
    toolResponse: 'tool_response' in obj ? obj['tool_response'] : undefined,
    error: str('error'),
    isInterrupt: bool('is_interrupt'),
    promptId: str('prompt_id'),
    agentId: str('agent_id'),
    agentType: str('agent_type'),
    cwd: str('cwd'),
    permissionMode: str('permission_mode'),
    durationMs: num('duration_ms'),
    toolUseId: str('tool_use_id'),
    source: str('source'),
    model: str('model'),
    extras,
    raw: parsed,
  };
}

// --- tool-name split ----------------------------------------------------------

// mcp__<server>__<tool> → { mcp: server, tool }. Non-greedy on the server so a
// tool name containing '__' splits at the FIRST separator; hyphens in server
// names ('spike-fs') pass through. Native tools map to the 'claude-code' bucket.
const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/s;

export function splitToolName(toolName: string): { mcp: string; tool: string } {
  const m = MCP_TOOL_RE.exec(toolName);
  if (m) return { mcp: m[1] as string, tool: m[2] as string };
  return { mcp: 'claude-code', tool: toolName };
}

// --- scannable text (single-scan: each fragment appears EXACTLY once) ----------

// Drive ×2 lesson (07/07): scanning the same text twice double-counts findings.
// Every extractor below collects parts and dedupes identical ones before joining.
function dedupeJoin(parts: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join('\n');
}

// Same shape semantics as frame-processor's extractResultText (content[].text
// where type==='text' + JSON.stringify(structuredContent)) with two tolerances:
// content may be a plain STRING (real Claude Code MCP hook payloads carry
// {"content":"[FILE] …"}), and identical parts are deduped.
function mcpShapeParts(value: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const content = value['content'];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text') {
        const text = (c as Record<string, unknown>)['text'];
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  const sc = value['structuredContent'];
  if (sc !== undefined) parts.push(JSON.stringify(sc));
  return parts;
}

export function requestScanText(parsed: ParsedHookEvent): string {
  return parsed.toolInput === undefined ? '' : JSON.stringify(parsed.toolInput);
}

export function responseScanText(parsed: ParsedHookEvent): string {
  // Failure: the error field, as-is.
  if (parsed.hookEventName === 'PostToolUseFailure') return parsed.error ?? '';

  const resp = parsed.toolResponse;
  if (resp === undefined) return '';
  const { mcp, tool } = splitToolName(parsed.toolName ?? '');

  if (mcp !== 'claude-code') {
    // MCP response: tool_response is a JSON STRING. Tolerant parse; MCP shape →
    // extractResultText semantics (deduped); anything else → the string itself.
    if (typeof resp === 'string') {
      try {
        const inner = JSON.parse(resp) as unknown;
        if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
          const parts = mcpShapeParts(inner as Record<string, unknown>);
          if (parts.length > 0) return dedupeJoin(parts);
        }
      } catch {
        // not JSON — fall through to the raw string
      }
      return resp;
    }
    return JSON.stringify(resp);
  }

  // Native families.
  if (typeof resp === 'object' && resp !== null && !Array.isArray(resp)) {
    const obj = resp as Record<string, unknown>;
    if (tool === 'Bash') {
      if (typeof obj['stdout'] === 'string' || typeof obj['stderr'] === 'string') {
        const parts: string[] = [];
        if (typeof obj['stdout'] === 'string') parts.push(obj['stdout']);
        if (typeof obj['stderr'] === 'string') parts.push(obj['stderr']);
        return dedupeJoin(parts);
      }
    }
    if (tool === 'Write' || tool === 'Edit' || tool === 'Read') {
      const parts: string[] = [];
      if (typeof obj['content'] === 'string') parts.push(obj['content']);
      if (typeof obj['patch'] === 'string') parts.push(obj['patch']);
      const sp = obj['structuredPatch'];
      if (Array.isArray(sp) && sp.length > 0) parts.push(JSON.stringify(sp));
      const file = obj['file'];
      if (file && typeof file === 'object') {
        const fc = (file as Record<string, unknown>)['content'];
        if (typeof fc === 'string') parts.push(fc);
      }
      if (parts.length > 0) return dedupeJoin(parts);
    }
  }
  // Unknown family: the whole response, once.
  return JSON.stringify(resp);
}

// --- synthesis ------------------------------------------------------------------

export interface SynthesizeContext {
  /** ULID naming the wrappers/<sessionUlid>.jsonl trail this session maps to. */
  sessionUlid: string;
  /** Capture instant = decode of the spool file's ULID name. */
  captureTimeMs: number;
  /** Envelope id generator (monotonic ULID factory in production). */
  nextId: () => string;
}

// Provenance extras ride the Envelope's index signature (F1.0-P2). source:
// 'claude-code' doubles as the reader's auth-signal guard (F1.2 v2 point 4).
function provenance(parsed: ParsedHookEvent): Record<string, unknown> {
  return {
    source: 'claude-code',
    ...(parsed.sessionId !== undefined ? { ccSession: parsed.sessionId } : {}),
    ...(parsed.promptId !== undefined ? { promptId: parsed.promptId } : {}),
    ...(parsed.agentId !== undefined ? { agentId: parsed.agentId } : {}),
    ...(parsed.agentType !== undefined ? { agentType: parsed.agentType } : {}),
    ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
  };
}

function ccEvent(
  raw: unknown,
  hookEventName: string | undefined,
  ccSession: string | undefined,
  ctx: SynthesizeContext,
): Envelope {
  return {
    v: 1,
    id: ctx.nextId(),
    ts: new Date(ctx.captureTimeMs).toISOString(),
    session: ctx.sessionUlid,
    mcp: 'claude-code',
    type: 'cc.event',
    source: 'claude-code',
    ...(hookEventName !== undefined ? { hookEventName } : {}),
    ...(ccSession !== undefined ? { ccSession } : {}),
    raw,
  };
}

// MCP results arrive as a JSON string → parse back to the real object (already
// MCP-shaped) or wrap the string. Native results are wrapped into MCP shape:
// scan text as content[].text, full original response under structuredContent
// (nothing lost). Classification does NOT re-extract from this shape — it uses
// responseScanText(parsed) directly, so the content/structuredContent overlap
// here can never double-scan.
function normalizeResult(parsed: ParsedHookEvent, mcp: string): unknown {
  const resp = parsed.toolResponse;
  if (mcp !== 'claude-code') {
    if (typeof resp === 'string') {
      try {
        const inner = JSON.parse(resp) as unknown;
        if (typeof inner === 'object' && inner !== null) return inner;
      } catch {
        // not JSON — wrap below
      }
      return { content: [{ type: 'text', text: resp }] };
    }
    return resp;
  }
  return {
    content: [{ type: 'text', text: responseScanText(parsed) }],
    structuredContent: resp,
  };
}

export function synthesize(parsed: ParsedHook, ctx: SynthesizeContext): Envelope[] {
  if (parsed.kind === 'unknown') return [ccEvent(parsed.raw, undefined, undefined, ctx)];

  const isPair =
    (parsed.hookEventName === 'PostToolUse' || parsed.hookEventName === 'PostToolUseFailure') &&
    typeof parsed.toolName === 'string';
  if (!isPair) return [ccEvent(parsed.raw, parsed.hookEventName, parsed.sessionId, ctx)];

  const { mcp, tool } = splitToolName(parsed.toolName as string);
  const rpcId: RpcId = parsed.toolUseId ?? null;
  // duration_ms absent → request ts === response ts === captureTime (tolerance).
  const requestTs = new Date(ctx.captureTimeMs - (parsed.durationMs ?? 0)).toISOString();
  const responseTs = new Date(ctx.captureTimeMs).toISOString();
  const extras = provenance(parsed);
  const params = { name: tool, arguments: parsed.toolInput };

  // bytes = size of the synthesized payload; overheadUs = 0 (both fields are
  // required by the 0c variants; there is no on-path proxy overhead here).
  const request: Envelope = {
    v: 1,
    id: ctx.nextId(),
    ts: requestTs,
    session: ctx.sessionUlid,
    mcp,
    type: 'mcp.request',
    direction: 'client_to_server',
    rpcId,
    method: 'tools/call',
    params,
    bytes: Buffer.byteLength(JSON.stringify(params), 'utf8'),
    overheadUs: 0,
    ...extras,
  };

  if (parsed.hookEventName === 'PostToolUseFailure') {
    const error = parsed.error ?? '';
    const response: Envelope = {
      v: 1,
      id: ctx.nextId(),
      ts: responseTs,
      session: ctx.sessionUlid,
      mcp,
      type: 'mcp.response',
      direction: 'server_to_client',
      rpcId,
      error,
      bytes: Buffer.byteLength(error, 'utf8'),
      overheadUs: 0,
      ...(parsed.durationMs !== undefined ? { latencyMs: parsed.durationMs } : {}),
      ...(parsed.isInterrupt !== undefined ? { isInterrupt: parsed.isInterrupt } : {}),
      ...extras,
    };
    return [request, response];
  }

  const result = normalizeResult(parsed, mcp);
  const response: Envelope = {
    v: 1,
    id: ctx.nextId(),
    ts: responseTs,
    session: ctx.sessionUlid,
    mcp,
    type: 'mcp.response',
    direction: 'server_to_client',
    rpcId,
    result,
    bytes: Buffer.byteLength(JSON.stringify(result ?? null), 'utf8'),
    overheadUs: 0,
    ...(parsed.durationMs !== undefined ? { latencyMs: parsed.durationMs } : {}),
    ...extras,
  };
  return [request, response];
}

// --- classification ---------------------------------------------------------------

// Takes the ParsedHook alongside the envelopes (declared deviation from the
// F1.2 v1 signature classify(envelopes)): the response scan text MUST be
// computed once from the parsed hook — re-deriving it from the normalized
// result would re-join content + structuredContent and double-scan (Drive ×2).
export function classify(
  envelopes: readonly Envelope[],
  parsed: ParsedHook,
  nextId: () => string,
): Envelope[] {
  if (parsed.kind !== 'hook') return [...envelopes];
  const { tool } = splitToolName(parsed.toolName ?? '');
  const out: Envelope[] = [];

  for (const env of envelopes) {
    if (env.type === 'mcp.request') {
      const mcpEnvelope: McpRequestEnvelope = {
        payload: env['params'],
        mcp: env.mcp,
        method: 'tools/call',
        direction: 'client_to_server',
        sessionId: env.session,
      };
      // buildDetectorInput per contract, then paramsJson = request scan text and
      // toolName = the SPLIT tool (F1.2 v2 point 1), not the raw mcp__* name.
      const input: DetectorInput = {
        ...buildDetectorInput(mcpEnvelope),
        paramsJson: requestScanText(parsed),
        toolName: tool,
      };
      const detections = emitDetections(input, ACTIVE_DETECTORS); // baseline included
      // (0k): one mcp.request PER detection, same rpcId/method/params.
      out.push({ ...env, detection: detections[0] });
      for (const extra of detections.slice(1)) out.push({ ...env, id: nextId(), detection: extra });
      continue;
    }

    if (env.type === 'mcp.response') {
      out.push(env);
      const text = responseScanText(parsed);
      if (text.length > 0) {
        // Mirror of frame-processor's inbound block (0h): envelope payload is
        // the TEXT, direction is the response's, toolName undefined (a result
        // has no tool name to classify), runDetectors (no baseline inbound).
        const input: DetectorInput = {
          envelope: {
            payload: text,
            mcp: env.mcp,
            method: 'tools/call',
            direction: 'server_to_client',
            sessionId: env.session,
          },
          paramsJson: text,
          toolName: undefined,
        };
        for (const detection of runDetectors(input, ACTIVE_DETECTORS)) {
          // 07/07 fix, verbatim from (0h): data_export_warning is downgraded to
          // 'low' INBOUND only (export language in a result is tool-poisoning
          // signal, not an outbound export command); findings land on 'result'.
          const severity = detection.category === 'data_export_warning' ? 'low' : detection.severity;
          const adjusted = {
            ...detection,
            severity,
            findings: detection.findings.map((f) => ({ ...f, location: 'result' })),
          };
          out.push({
            v: 1,
            id: nextId(),
            ts: env.ts,
            session: env.session,
            mcp: env.mcp,
            type: 'mcp.detection_enrichment',
            rpcId: env['rpcId'] as RpcId,
            direction: 'server_to_client',
            detection: adjusted,
            overheadUs: 0,
            source: 'claude-code',
            ...(parsed.sessionId !== undefined ? { ccSession: parsed.sessionId } : {}),
          });
        }
      }
      continue;
    }

    out.push(env);
  }
  return out;
}
