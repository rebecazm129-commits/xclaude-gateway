import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DetectionEvent,
  DetectionEnrichmentEvent,
  EnrichableEvent,
} from '../shared/types.js';
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

export async function readDetections(
  dir: string = DEFAULT_WRAPPERS_DIR,
): Promise<EnrichableEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const jsonlFiles = entries.filter((name) => name.endsWith('.jsonl'));
  const seenIds = new Set<string>();
  const requests: DetectionEvent[] = [];
  const enrichments: DetectionEnrichmentEvent[] = [];
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
      if (isDetectionEvent(parsed)) {
        if (seenIds.has(parsed.id)) continue;
        seenIds.add(parsed.id);
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
  const results: EnrichableEvent[] = [...requests, ...orphanEnrichments];
  results.sort((a, b) => b.ts.localeCompare(a.ts));
  return results;
}
