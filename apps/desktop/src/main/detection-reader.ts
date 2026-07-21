import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DetectionEvent,
  DetectionEnrichmentEvent,
  EnrichableEvent,
  ToolCount,
  ConnectorAuthAlert,
  DetectionListResult,
} from '../shared/types.js';
import { DAY_MS } from '../shared/types.js';
import { SELFTEST_WRAPPER_NAME } from './selftest-runner.js';
import { CONNECTOR_RECOVERED_TYPE } from './recovery-writer.js';

const DEFAULT_WRAPPERS_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'xCLAUDE Gateway',
  'wrappers',
);

function isDetectionEvent(value: unknown): value is DetectionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj['type'] !== 'mcp.request') return false;
  const rpcId = obj['rpcId'];
  const rpcIdOk =
    typeof rpcId === 'string' ||
    typeof rpcId === 'number' ||
    rpcId === null;
  if (!rpcIdOk) return false;
  if (
    obj['direction'] !== 'client_to_server' &&
    obj['direction'] !== 'server_to_client'
  ) {
    return false;
  }
  const det = obj['detection'];
  if (typeof det !== 'object' || det === null) return false;
  const block = det as Record<string, unknown>;
  return (
    typeof block['category'] === 'string' &&
    typeof block['severity'] === 'string' &&
    Array.isArray(block['findings'])
  );
}

function isDetectionEnrichmentEvent(
  value: unknown,
): value is DetectionEnrichmentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj['type'] !== 'mcp.detection_enrichment') return false;
  const rpcId = obj['rpcId'];
  const rpcIdOk =
    typeof rpcId === 'string' ||
    typeof rpcId === 'number' ||
    rpcId === null;
  if (!rpcIdOk) return false;
  if (
    obj['direction'] !== 'client_to_server' &&
    obj['direction'] !== 'server_to_client'
  ) {
    return false;
  }
  const det = obj['detection'];
  if (typeof det !== 'object' || det === null) return false;
  const block = det as Record<string, unknown>;
  return (
    typeof block['category'] === 'string' &&
    typeof block['severity'] === 'string' &&
    Array.isArray(block['findings'])
  );
}

// Shared listing used by readDetections and readLatestToolCount. ENOENT → [].
export async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith('.jsonl'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// A single auth-relevant signal extracted from one JSONL line. The AuditStore
// caches these per file so assembleAudit can rebuild the auth-alert maps without
// re-reading disk. mcp/ts always present; message only for 'fail'.
export interface AuthSignal {
  mcp: string;
  ts: string;
  kind: 'fail' | 'live' | 'recovery';
  message?: string;
}

// One file's parsed contribution: derived detection/enrichment events (in line
// order, NOT deduped — dedup happens across files in assembleAudit) plus the
// auth signals. Shared by readAudit (full read) and the incremental AuditStore.
export interface ParsedFile {
  events: EnrichableEvent[];
  authSignals: AuthSignal[];
}

// Pure per-file parse: JSONL text → events + auth signals. Same tolerance as the
// original inline loop (blank lines, malformed JSON, self-test exclusion), and
// the same toolName/argumentsJson/overheadUs derivation so cached events are
// render-ready. Dedup is deliberately NOT done here (see assembleAudit).
// argsSummary (F2.4): prioridad del "argumento principal" por tool. Bash es
// su comando; las tools de fichero su path. Para el resto (MCP incluidas),
// la lista genérica cubre los campos-cabecera habituales; si ninguno está,
// cae al primer valor string de arguments (orden de inserción del JSON).
// Sin dumps de objetos — el drawer ya enseña argumentsJson completo.
const ARGS_SUMMARY_PRIORITY: readonly string[] = [
  'command', 'file_path', 'path', 'url', 'query', 'pattern', 'text',
];
const ARGS_SUMMARY_MAX = 100;

function clipSummary(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= ARGS_SUMMARY_MAX) return oneLine;
  return `${oneLine.slice(0, ARGS_SUMMARY_MAX - 1)}…`;
}

// summarizeArgs — pure (exported for tests): the short one-line summary the
// Claude Code view shows in its Args column. Input is the ALREADY-PERSISTED
// arguments object from the trail — credential masking happened at write
// time, so this never touches a raw channel. Whitespace collapses to single
// spaces; truncated at ARGS_SUMMARY_MAX. undefined when nothing string-valued
// exists to summarize.
export function summarizeArgs(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return undefined;
  }
  const obj = args as Record<string, unknown>;
  const candidates: string[] = [];
  if (toolName === 'Bash') candidates.push('command');
  else if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    candidates.push('file_path');
  }
  candidates.push(...ARGS_SUMMARY_PRIORITY);
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return clipSummary(v);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim() !== '') return clipSummary(v);
  }
  return undefined;
}

export function parseAuditContent(content: string): ParsedFile {
  const events: EnrichableEvent[] = [];
  const authSignals: AuthSignal[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // Self-test synthetic events (wrapper --name SELFTEST_WRAPPER_NAME) are
    // excluded: demonstrative, not real MCP traffic. Identified by reserved name.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['mcp'] === SELFTEST_WRAPPER_NAME
    ) {
      continue;
    }
    // Auth-signal extraction. A single mcp.request line yields BOTH a 'live'
    // signal here AND a detection event below — exactly as the original
    // interleaved loop did (it fell through to the detection guards).
    // Lines with source 'claude-code' are EXCLUDED (F1.2 v2 point 4c): tool
    // traffic observed via Claude Code hooks says nothing about the Gateway
    // connector's auth state — an mcp named 'notion' here must not mark the
    // homonymous Gateway connector "live". The detection events below still
    // include them (accepted until F1.3 adds a source filter to the list).
    {
      const obj = parsed as Record<string, unknown>;
      const ty = obj['type'];
      const mcp = obj['mcp'];
      const ts = obj['ts'];
      if (typeof mcp === 'string' && typeof ts === 'string' && obj['source'] !== 'claude-code') {
        if (ty === 'proxy.error' && obj['kind'] === 'oauth_failed') {
          authSignals.push({
            mcp,
            ts,
            kind: 'fail',
            message: typeof obj['message'] === 'string' ? obj['message'] : '',
          });
        } else if (typeof ty === 'string' && ty.startsWith('mcp.')) {
          authSignals.push({ mcp, ts, kind: 'live' });
        } else if (ty === CONNECTOR_RECOVERED_TYPE) {
          // Desktop-written positive signal after a successful reconnect.
          authSignals.push({ mcp, ts, kind: 'recovery' });
        }
      }
    }
    if (isDetectionEvent(parsed)) {
      // Derivar toolName desde params.name solo cuando method === 'tools/call'
      // y name es string. Mantiene el renderer libre de maquinaria JSON-RPC.
      if (parsed.method === 'tools/call') {
        const raw = parsed as unknown as {
          params?: { name?: unknown; arguments?: unknown };
        };
        if (typeof raw.params?.name === 'string') {
          parsed.toolName = raw.params.name;
        }
        // argumentsJson: string ya serializado pretty-printed. El renderer NO
        // toca params crudo. Sin stringify por render.
        if (raw.params?.arguments !== undefined) {
          try {
            parsed.argumentsJson = JSON.stringify(raw.params.arguments, null, 2);
          } catch {
            // Referencias circulares u otros casos raros: omitir el campo.
          }
        }
        // argsSummary (F2.4): derivado AQUÍ (no en toSlim — la caché slim ya
        // dropeó params/argumentsJson cuando toSlim corre). Mismo patrón que
        // toolName; al reconstruirse del disco, los históricos también lo
        // llevan. slimEvent lo retiene, toSlim lo copia a la fila.
        const summary = summarizeArgs(parsed.toolName, raw.params?.arguments);
        if (summary !== undefined) parsed.argsSummary = summary;
      }
      // overheadUs si el JSONL lo trae. Aplica a TODOS los mcp.request.
      const rawOverhead = parsed as unknown as { overheadUs?: unknown };
      if (typeof rawOverhead.overheadUs === 'number') {
        parsed.overheadUs = rawOverhead.overheadUs;
      }
      events.push(parsed);
    } else if (isDetectionEnrichmentEvent(parsed)) {
      events.push(parsed);
    }
  }
  return { events, authSignals };
}

// deriveAuthAlerts — pure: derives connector auth alerts from the
// authSignals across all files, with the same 24h "needsRelogin"
// window and stable ordering that assembleAudit uses. Extracted so
// both assembleAudit AND the AuditStore's early-exit can share a
// single source of truth for auth alerts (F2.2 paso 4).
export function deriveAuthAlerts(
  files: readonly ParsedFile[],
  now: number,
): ConnectorAuthAlert[] {
  // ISO-Z timestamps compare lexicographically === chronologically.
  const lastFailTs: Record<string, string> = {};
  const lastFailMsg: Record<string, string> = {};
  const lastLiveTs: Record<string, string> = {};
  const lastRecoveryTs: Record<string, string> = {};
  for (const file of files) {
    for (const sig of file.authSignals) {
      if (sig.kind === 'fail') {
        const prev = lastFailTs[sig.mcp];
        if (prev === undefined || sig.ts > prev) {
          lastFailTs[sig.mcp] = sig.ts;
          lastFailMsg[sig.mcp] = sig.message ?? '';
        }
      } else if (sig.kind === 'live') {
        const prev = lastLiveTs[sig.mcp];
        if (prev === undefined || sig.ts > prev) lastLiveTs[sig.mcp] = sig.ts;
      } else {
        const prev = lastRecoveryTs[sig.mcp];
        if (prev === undefined || sig.ts > prev) lastRecoveryTs[sig.mcp] = sig.ts;
      }
    }
  }
  // needsRelogin: a recent failure (≤24h) with no later live traffic.
  // Sorted deterministically: lastFailureTs desc, then mcp asc.
  const authAlerts: ConnectorAuthAlert[] = [];
  for (const mcp of Object.keys(lastFailTs)) {
    const failTs = lastFailTs[mcp]!;
    const failMs = Date.parse(failTs);
    if (Number.isNaN(failMs) || now - failMs > DAY_MS) continue;
    const liveTs = lastLiveTs[mcp];
    const recoveryTs = lastRecoveryTs[mcp];
    const laterSignal =
      liveTs !== undefined && recoveryTs !== undefined
        ? liveTs > recoveryTs
          ? liveTs
          : recoveryTs
        : liveTs ?? recoveryTs;
    if (laterSignal !== undefined && failTs < laterSignal) continue;
    authAlerts.push({ mcp, lastFailureTs: failTs, message: lastFailMsg[mcp] ?? '' });
  }
  authAlerts.sort((a, b) =>
    a.lastFailureTs === b.lastFailureTs
      ? a.mcp.localeCompare(b.mcp)
      : b.lastFailureTs.localeCompare(a.lastFailureTs),
  );
  return authAlerts;
}

// Pure assembly of the full result from per-file parsed contributions (given in
// readdir order). Dedups by id across files, correlates enrichment↔request by
// (session, rpcId, direction) WITHOUT mutating the input events (output rows are
// shallow copies — the AuditStore's cache is never mutated), keeps orphan
// enrichments, sorts by ts desc, and derives authAlerts. readAudit and the
// AuditStore both call this, so they agree by construction.
export function assembleAudit(
  files: readonly ParsedFile[],
  now: number,
): DetectionListResult {
  const seenIds = new Set<string>();
  const requests: DetectionEvent[] = [];
  const enrichments: DetectionEnrichmentEvent[] = [];
  for (const file of files) {
    for (const ev of file.events) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      if (ev.type === 'mcp.request') {
        requests.push(ev as DetectionEvent);
      } else {
        enrichments.push(ev as DetectionEnrichmentEvent);
      }
    }
  }
  // Clave de correlacion (session, rpcId, direction). JSON.stringify del array
  // escapa cualquier caracter, asi que la clave es inyectiva.
  const key = (
    session: string,
    rpcId: string | number | null,
    direction: string,
  ): string => JSON.stringify([session, rpcId, direction]);
  const enrichmentByKey = new Map<string, DetectionEnrichmentEvent>();
  for (const enr of enrichments) {
    enrichmentByKey.set(key(enr.session, enr.rpcId, enr.direction), enr);
  }
  const matchedEnrichmentIds = new Set<string>();
  // Output rows are COPIES: the caller's cached events are never mutated.
  const outRequests: DetectionEvent[] = requests.map((req) => {
    const match = enrichmentByKey.get(key(req.session, req.rpcId, req.direction));
    if (match) {
      matchedEnrichmentIds.add(match.id);
      return { ...req, enrichment: match.detection };
    }
    return { ...req };
  });
  // Enrichment huerfano: se mantiene como fila propia (copia).
  const orphanEnrichments = enrichments
    .filter((enr) => !matchedEnrichmentIds.has(enr.id))
    .map((enr) => ({ ...enr }));
  const events: EnrichableEvent[] = [...outRequests, ...orphanEnrichments];
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  const authAlerts = deriveAuthAlerts(files, now);
  return { events, authAlerts };
}

// Full read: list → read each file whole → parse → assemble. The proven
// reference implementation (used by the AuditStore's golden-oracle tests).
export async function readAudit(
  dir: string = DEFAULT_WRAPPERS_DIR,
  now: number = Date.now(),
): Promise<DetectionListResult> {
  const jsonlFiles = await listJsonlFiles(dir);
  const parsedFiles: ParsedFile[] = [];
  for (const filename of jsonlFiles) {
    const filePath = join(dir, filename);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (err) {
      // A single unreadable entry (EACCES, EISDIR from a directory named
      // *.jsonl, a file deleted mid-scan) must NOT blank the whole audit.
      console.error(`readAudit: skipping unreadable file ${filePath}:`, err);
      continue;
    }
    parsedFiles.push(parseAuditContent(content));
  }
  return assembleAudit(parsedFiles, now);
}

// Back-compat wrapper: callers/tests that only want the event list. Single pass
// under the hood (delegates to readAudit), so no extra disk read.
export async function readDetections(
  dir: string = DEFAULT_WRAPPERS_DIR,
): Promise<EnrichableEvent[]> {
  return (await readAudit(dir)).events;
}

// Reads the most recent tools/list response's tool count for a given mcp. The
// proxy audits every server→client frame, so result.tools is present verbatim
// in the JSONL (no proxy change needed). Files are ULID-named → lexicographic
// order is chronological; we scan newest file first and, within a file, newest
// line first (append-only), returning on the first match. null if none.
function toolsListResponseFor(value: unknown, mcp: string): ToolCount | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj['type'] !== 'mcp.response' || obj['mcp'] !== mcp) return null;
  const result = obj['result'];
  if (typeof result !== 'object' || result === null) return null;
  const tools = (result as Record<string, unknown>)['tools'];
  if (!Array.isArray(tools)) return null;
  const ts = obj['ts'];
  return { count: tools.length, ts: typeof ts === 'string' ? ts : '' };
}

export async function readLatestToolCount(
  mcp: string,
  dir: string = DEFAULT_WRAPPERS_DIR,
): Promise<ToolCount | null> {
  const files = await listJsonlFiles(dir);
  // ULID filenames sort lexicographically by creation time → newest first.
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const filename of files) {
    const content = await readFile(join(dir, filename), 'utf8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const match = toolsListResponseFor(parsed, mcp);
      if (match) return match; // early exit: first match is the latest
    }
  }
  return null;
}
