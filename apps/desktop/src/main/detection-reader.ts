import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DetectionEvent,
  DetectionEnrichmentEvent,
  EnrichableEvent,
} from '../shared/types.js';

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
  const results: EnrichableEvent[] = [];
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
      if (isDetectionEvent(parsed) || isDetectionEnrichmentEvent(parsed)) {
        results.push(parsed);
      }
    }
  }
  results.sort((a, b) => b.ts.localeCompare(a.ts));
  return results;
}
