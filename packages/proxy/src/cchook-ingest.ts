// cchook-ingest — PURE translation of captured Claude Code hook payloads into
// audit-trail envelopes (F1.2). No fs, no side effects: bytes in, Envelope[]
// out. The fs orchestration (spool readdir, session map, append, unlink) lives
// in the desktop ingester (apps/desktop/src/main/cchook-ingester.ts), which
// imports this module through the '@xcg/proxy/cchook-ingest' export.
//
// Synthesis contract (F1.2 v2, anchored on frame-processor verbatims):
//   PostToolUse        → mcp.request + mcp.response paired by rpcId=tool_use_id
//   PostToolUseFailure → mcp.request + mcp.response with `error` (0c variant)
//   SessionStart/SessionEnd → one 'cc.event' line with an explicit whitelist
//     of fields (SESSION_EVENT_FIELDS) — never the raw payload;
//   any other event, or a payload that does not parse → one 'cc.event' with
//     payload_omitted and the NAMES of its top-level keys, no values.
//   INVARIANT: no Claude Code hook event reaches the trail without an explicit
//   schema of what is kept. A new hook event (Elicitation, whose result
//   carries what the user typed) is recorded as having happened, not stored,
//   until someone writes its schema here. The desktop reader ignores cc.event
//   without breaking (0e).
// Classification replicates the wrapper EXACTLY:
//   request  → detection inline on mcp.request; multi-label = one mcp.request
//              per detection (frame-processor emits detections.map(...), 0k).
//   response/failure text → one mcp.detection_enrichment PER matching detector,
//              direction = the response's ('server_to_client'), findings
//              remapped to location 'result'. The detector chain is
//              CONTENT_DETECTORS (detectors/index.ts), SHARED with
//              frame-processor's inbound block so the two routes cannot drift:
//              data_export_warning runs its strict inbound variant and keeps
//              its own 'medium'. There is NO severity downgrade here — the
//              07/07 inbound 'low' is gone (67bcd55, 28/08); the strictness
//              lives in the regex. A parity test over the same payload pins
//              both routes to the same category and severity
//              (tests/cchook-ingest.test.ts, 'route parity').
//   Baseline tool_call_allowed only on the request (emitDetections); inbound
//   emits nothing when no detector fires, like the wrapper.

import { CLAUDE_CODE_DETECTORS, CONTENT_DETECTORS, credentialMatches } from './detection/detectors/index.js';
import { buildDetectorInput, emitDetections, runDetectors } from './detection/engine.js';
import type { DetectorInput, DetectorOutput, McpRequestEnvelope, RpcId } from './detection/types.js';
import type { Envelope } from './audit.js';
import { REDACTION_VERSION } from './cchook-spool.js';
import { attachMaskSecrets } from './events.js';

export { cchookSpoolDir } from './cchook-paths.js';
// Re-exported for the desktop ingester's serialize step (precedent:
// cchookSpoolDir, F1.2) — it masks envelopes outside EventSink with the SAME
// helpers and the SAME per-install salt the wrappers use, so a credential
// carries an identical fingerprint whether seen on the wire or via a hook.
export { readMaskSecrets } from './events.js';
export { maskCredentials, resolveAuditKey } from './detection/masking.js';

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

// --- spool file ----------------------------------------------------------------

/** What one spool file holds, read back. */
export interface SpoolContent {
  parsed: ParsedHook;
  /** The masks xcg-cchook applied (fp → type). Only these raise
   *  credential_detected: the payload no longer contains the secret itself,
   *  and a mask that was already in the text (the trail being read, say) is
   *  not something this call leaked. */
  hookMasks: ReadonlyMap<string, string>;
  /** null for a file written before redaction existed (raw payload). */
  redactionVersion: number | null;
}

const NO_MASKS: ReadonlyMap<string, string> = new Map();

/**
 * Read a spool file in either format: the redacted one xcg-cchook writes now
 * ({ redaction_version, masked, payload } — see cchook-spool.ts), or a raw
 * payload left by an older hook. An omitted record (redaction failed) parses
 * as an unknown payload, so it lands as a cc.event naming only its keys.
 */
export function readSpool(bytes: Buffer | string): SpoolContent {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { parsed: parseHookPayload(text), hookMasks: NO_MASKS, redactionVersion: null };
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    const version = o['redaction_version'];
    if (typeof version === 'number' && version <= REDACTION_VERSION && typeof o['payload'] === 'string') {
      const masks = new Map<string, string>();
      if (Array.isArray(o['masked'])) {
        for (const m of o['masked']) {
          if (m !== null && typeof m === 'object') {
            const { type, fp } = m as Record<string, unknown>;
            if (typeof type === 'string' && typeof fp === 'string') masks.set(fp, type);
          }
        }
      }
      return { parsed: parseHookPayload(o['payload']), hookMasks: masks, redactionVersion: version };
    }
    if (typeof version === 'number') {
      // An omitted record, or a newer format this build cannot read: never
      // guess at it — keep only its key names.
      return { parsed: parseHookPayload(text), hookMasks: NO_MASKS, redactionVersion: version };
    }
  }
  return { parsed: parseHookPayload(text), hookMasks: NO_MASKS, redactionVersion: null };
}

const MASK_TOKEN = /\[credential:([a-z_]+) fp:([0-9a-f]{16})\]/g;

/** credential_detected from the masks the HOOK applied, found in `text`. */
function hookMaskedCredential(
  text: string,
  hookMasks: ReadonlyMap<string, string>,
  location: string,
): DetectorOutput | null {
  if (hookMasks.size === 0) return null;
  const findings: { type: string; location: string }[] = [];
  for (const m of text.matchAll(MASK_TOKEN)) {
    if (hookMasks.get(m[2]!) === m[1]) findings.push({ type: m[1]!, location });
  }
  return findings.length === 0 ? null : { category: 'credential_detected', severity: 'critical', findings };
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
// cwd (F2.4) is forward-only: historical envelopes don't carry it, so every
// consumer downstream must tolerate absence.
function provenance(parsed: ParsedHookEvent): Record<string, unknown> {
  return {
    source: 'claude-code',
    ...(parsed.sessionId !== undefined ? { ccSession: parsed.sessionId } : {}),
    ...(parsed.promptId !== undefined ? { promptId: parsed.promptId } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    ...(parsed.agentId !== undefined ? { agentId: parsed.agentId } : {}),
    ...(parsed.agentType !== undefined ? { agentType: parsed.agentType } : {}),
    ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
  };
}

/**
 * The fields each non-tool event keeps, by name. SessionStart and SessionEnd
 * are the only ones the trail has ever held (98 lines on 28/09); their other
 * keys — transcript_path, scratchpad_dir, prompt_id — are left out: nothing
 * reads them. Only string values are kept. The envelope carries hookEventName
 * (the compactor's SessionEnd terminal) and ccSession on its own.
 */
export const SESSION_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  SessionStart: ['source', 'model', 'cwd'],
  SessionEnd: ['reason', 'cwd'],
};

const topLevelKeys = (value: unknown): string[] =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];

function ccEvent(parsed: ParsedHook, ctx: SynthesizeContext): Envelope {
  const base: Envelope = {
    v: 1,
    id: ctx.nextId(),
    ts: new Date(ctx.captureTimeMs).toISOString(),
    session: ctx.sessionUlid,
    mcp: 'claude-code',
    type: 'cc.event',
    source: 'claude-code',
  };
  if (parsed.kind === 'unknown') {
    // Not JSON, or no hook_event_name: nothing identifies what it is, so
    // nothing of it is kept — at most the names of its keys.
    let keys: string[] = [];
    try {
      keys = topLevelKeys(JSON.parse(parsed.raw));
    } catch {
      // unparseable: no keys to name
    }
    return { ...base, payload_omitted: true, keys };
  }
  const head = {
    hookEventName: parsed.hookEventName,
    ...(parsed.sessionId !== undefined ? { ccSession: parsed.sessionId } : {}),
  };
  const allowed = SESSION_EVENT_FIELDS[parsed.hookEventName];
  if (allowed === undefined) {
    return { ...base, ...head, payload_omitted: true, keys: topLevelKeys(parsed.raw) };
  }
  const raw = parsed.raw as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of allowed) {
    const value = raw[key];
    if (typeof value === 'string') fields[key] = value;
  }
  return { ...base, ...head, fields };
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
  if (parsed.kind === 'unknown') return [ccEvent(parsed, ctx)];

  const isPair =
    (parsed.hookEventName === 'PostToolUse' || parsed.hookEventName === 'PostToolUseFailure') &&
    typeof parsed.toolName === 'string';
  if (!isPair) return [ccEvent(parsed, ctx)];

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
  hookMasks: ReadonlyMap<string, string> = NO_MASKS,
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
        // The session's working directory, for detectors that resolve
        // relative paths (audit_trail_modification). Absent before F2.4.
        ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
      };
      let detections = emitDetections(input, CLAUDE_CODE_DETECTORS); // baseline included
      // A credential the hook already masked is no longer in the text for the
      // detector to find; its mask is the evidence. It replaces the baseline.
      const masked = hookMaskedCredential(input.paramsJson, hookMasks, 'params');
      if (masked !== null) {
        detections = [masked, ...detections.filter((d) => d.category !== 'tool_call_allowed')];
      }
      // (0k): one mcp.request PER detection, same rpcId/method/params.
      const reqEvents: Envelope[] = [
        { ...env, detection: detections[0] },
        ...detections.slice(1).map((extra) => ({ ...env, id: nextId(), detection: extra })),
      ];
      // Credential masking (b.2): if a credential fired, tag every request
      // event (they share the same tool_input params) with the matched values
      // so the ingester's serialize step redacts them — same Symbol channel,
      // same scan, as the wrapper path (b.1).
      if (detections.some((d) => d.category === 'credential_detected')) {
        const secrets = credentialMatches(input.paramsJson);
        for (const e of reqEvents) attachMaskSecrets(e, secrets);
      }
      for (const e of reqEvents) out.push(e);
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
        const maskedInbound = hookMaskedCredential(text, hookMasks, 'result');
        for (const detection of [
          ...(maskedInbound !== null ? [maskedInbound] : []),
          ...runDetectors(input, CONTENT_DETECTORS),
        ]) {
          // Inbound credential in the result/error text → mask it out of the
          // persisted mcp.response (env, pushed above, carries the raw
          // result/error). Reuse the same scan; the enrichment below only
          // carries findings, never the secret.
          if (detection.category === 'credential_detected') {
            attachMaskSecrets(env, credentialMatches(text));
          }
          // Mirror of frame-processor's inbound block: CONTENT_DETECTORS runs
          // data_export_warning's STRICT variant (explicit destination), so
          // what fires keeps the detector's own severity — the strictness
          // lives in the regex, not in a downgrade (the 07/07 inbound 'low'
          // is gone here too; it had outlived the proxy's move to the strict
          // variant and left the two routes classifying differently).
          const adjusted = {
            ...detection,
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

    // cc.event — nothing to classify or mask: it holds no payload. SessionStart
    // and SessionEnd carry only their whitelisted fields, anything else only
    // the names of its keys (ccEvent, SESSION_EVENT_FIELDS), so no hook
    // content — a secret, what a user typed into an elicitation — can reach
    // the trail through this line.
    out.push(env);
  }
  return out;
}
