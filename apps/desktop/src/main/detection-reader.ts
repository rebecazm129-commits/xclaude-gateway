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
async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith('.jsonl'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function readAudit(
  dir: string = DEFAULT_WRAPPERS_DIR,
  now: number = Date.now(),
): Promise<DetectionListResult> {
  const jsonlFiles = await listJsonlFiles(dir);
  const seenIds = new Set<string>();
  const requests: DetectionEvent[] = [];
  const enrichments: DetectionEnrichmentEvent[] = [];
  // Auth-alert tracking, same pass. ISO-Z timestamps compare lexicographically
  // === chronologically, so string max/compare is safe.
  const lastFailTs: Record<string, string> = {};
  const lastFailMsg: Record<string, string> = {};
  const lastLiveTs: Record<string, string> = {};
  for (const filename of jsonlFiles) {
    const filePath = join(dir, filename);
    const content = await readFile(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      // Self-test synthetic events (wrapper --name SELFTEST_WRAPPER_NAME) are
      // excluded from the audit dashboard: they are demonstrative, not real MCP
      // traffic (C2.B.1.a, decision A). Identified structurally by the reserved
      // wrapper name.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['mcp'] === SELFTEST_WRAPPER_NAME
      ) {
        continue;
      }
      // Auth-alert tracking (proxy.error/oauth_failed vs live mcp.* traffic),
      // same pass. These lines are not detection events, so they fall through
      // the guards below; we capture them here before that.
      {
        const obj = parsed as Record<string, unknown>;
        const ty = obj['type'];
        const mcp = obj['mcp'];
        const ts = obj['ts'];
        if (typeof mcp === 'string' && typeof ts === 'string') {
          if (ty === 'proxy.error' && obj['kind'] === 'oauth_failed') {
            const prevFail = lastFailTs[mcp];
            if (prevFail === undefined || ts > prevFail) {
              lastFailTs[mcp] = ts;
              lastFailMsg[mcp] = typeof obj['message'] === 'string' ? obj['message'] : '';
            }
          } else if (typeof ty === 'string' && ty.startsWith('mcp.')) {
            const prevLive = lastLiveTs[mcp];
            if (prevLive === undefined || ts > prevLive) {
              lastLiveTs[mcp] = ts;
            }
          }
        }
      }
      if (isDetectionEvent(parsed)) {
        if (seenIds.has(parsed.id)) continue;
        seenIds.add(parsed.id);
        // Derivar toolName desde params.name solo cuando method === 'tools/call'
        // y name es string. Mantiene el renderer libre de maquinaria JSON-RPC
        // (params shape, optional fields). Decision 1 del contrato preservada.
        if (parsed.method === 'tools/call') {
          const raw = parsed as unknown as {
            params?: { name?: unknown; arguments?: unknown };
          };
          if (typeof raw.params?.name === 'string') {
            parsed.toolName = raw.params.name;
          }
          // Derivar argumentsJson: string ya serializado pretty-printed. El
          // renderer NO toca params crudo. Sin stringify por render.
          if (raw.params?.arguments !== undefined) {
            try {
              parsed.argumentsJson = JSON.stringify(raw.params.arguments, null, 2);
            } catch {
              // Referencias circulares u otros casos raros: omitir el campo.
              // JSON.parse de la linea ya filtró la mayoría, pero defensivo.
            }
          }
        }
        // Derivar overheadUs si el JSONL lo trae. Aplica a TODOS los
        // mcp.request (no solo tools/call), porque el overhead se mide
        // independientemente del method.
        const rawOverhead = parsed as unknown as { overheadUs?: unknown };
        if (typeof rawOverhead.overheadUs === 'number') {
          parsed.overheadUs = rawOverhead.overheadUs;
        }
        requests.push(parsed);
      } else if (isDetectionEnrichmentEvent(parsed)) {
        if (seenIds.has(parsed.id)) continue;
        seenIds.add(parsed.id);
        enrichments.push(parsed);
      }
    }
  }
  // Clave de correlacion (session, rpcId, direction). JSON.stringify del
  // array escapa cualquier caracter, asi que la clave es inyectiva sin
  // depender de que un separador no aparezca en los datos (rpcId puede ser
  // un string arbitrario por el spec JSON-RPC).
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
  for (const req of requests) {
    const match = enrichmentByKey.get(
      key(req.session, req.rpcId, req.direction),
    );
    if (match) {
      req.enrichment = match.detection;
      matchedEnrichmentIds.add(match.id);
    }
  }
  // Enrichment huerfano (sin request que correlacione): se mantiene como
  // fila propia. El reader es la unica autoridad de "que se ve", descartar
  // senal seria mentir en una herramienta de auditoria.
  const orphanEnrichments = enrichments.filter(
    (enr) => !matchedEnrichmentIds.has(enr.id),
  );
  const events: EnrichableEvent[] = [...requests, ...orphanEnrichments];
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  // needsRelogin: a recent failure (≤24h) with no later live traffic. Sorted
  // deterministically: lastFailureTs desc, then mcp asc (stable banner/tests).
  const authAlerts: ConnectorAuthAlert[] = [];
  for (const mcp of Object.keys(lastFailTs)) {
    const failTs = lastFailTs[mcp]!;
    const failMs = Date.parse(failTs);
    if (Number.isNaN(failMs) || now - failMs > DAY_MS) continue;
    const liveTs = lastLiveTs[mcp];
    if (liveTs !== undefined && failTs < liveTs) continue;
    authAlerts.push({ mcp, lastFailureTs: failTs, message: lastFailMsg[mcp] ?? '' });
  }
  authAlerts.sort((a, b) =>
    a.lastFailureTs === b.lastFailureTs
      ? a.mcp.localeCompare(b.mcp)
      : b.lastFailureTs.localeCompare(a.lastFailureTs),
  );
  return { events, authAlerts };
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
