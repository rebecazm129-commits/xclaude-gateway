// Audit-trail exporter (main process, no Electron dependency). Re-reads the
// wrappers JSONL from disk — NOT the AuditStore's slim cache — so raw params
// survive. Filters COMPLETE detection events with matchesFilter (shared with
// paginate → identical filtering), sorts ts-asc (chronological archive), and
// streams to a tmp in the destination's own directory, renamed atomically on
// success. On any failure the tmp is removed and the destination is untouched.

import { createWriteStream } from 'node:fs';
import { readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { DetectionFilter, EnrichableEvent } from '../shared/types.js';
import { listJsonlFiles, parseAuditContent } from './detection-reader.js';
import { matchesFilter } from './detection-page.js';

export type AuditExportFormat = 'jsonl' | 'csv';

export interface AuditExportOptions {
  dir: string;
  destPath: string;
  filter: DetectionFilter;
  format: AuditExportFormat;
  now?: number;
}

export interface AuditExportOutcome {
  count: number;
}

// One matching detection event: its raw source line (for JSONL fidelity) plus
// the parsed event (for CSV columns) and the sort key.
interface MatchedLine {
  ts: string;
  id: string;
  rawLine: string;
  event: EnrichableEvent;
}

// Columnas de correlación (frente 3) AL FINAL — no romper consumidores
// posicionales de las 8 columnas originales.
export const CSV_HEADER = 'ts,mcp,type,method,tool,category,severity,findings_count,cc_tool_use_id,paired_source';

// RFC 4180: quote a field containing comma, quote, CR or LF; double inner quotes.
function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function csvRow(e: EnrichableEvent, ccToolUseId = '', pairedSource = ''): string {
  const method = e.type === 'mcp.request' ? e.method : '';
  const tool = e.type === 'mcp.request' ? e.toolName ?? '' : '';
  const cols = [
    e.ts,
    e.mcp,
    e.type,
    method,
    tool,
    e.detection.category,
    e.detection.severity,
    String(e.detection.findings.length),
    ccToolUseId,
    pairedSource,
  ];
  return cols.map(csvEscape).join(',');
}

// --- correlación cross-source (frente 3) --------------------------------------

// Tupla mínima acumulada de CADA línea de detección parseada, pase o no el
// filtro — nunca se retiene el evento completo de las no filtradas.
interface CorrTuple {
  session: string;
  rpcId: EnrichableEvent['rpcId'];
  type: EnrichableEvent['type'];
  ccToolUseId?: string;
  source?: string;
}

const rpcKey = (session: string, rpcId: EnrichableEvent['rpcId']): string =>
  JSON.stringify([session, rpcId]);

// Clave efectiva: la propia del evento o, para enrichments sin clave, la
// heredada por (session, rpcId). A diferencia del reader, aquí la herencia
// aplica a TODO enrichment sin clave (el export no fusiona; una línea = una
// fila).
function effectiveToolUseId(
  t: CorrTuple,
  toolUseByRpc: ReadonlyMap<string, string>,
): string | undefined {
  if (t.ccToolUseId !== undefined) return t.ccToolUseId;
  if (t.type !== 'mcp.detection_enrichment') return undefined;
  return toolUseByRpc.get(rpcKey(t.session, t.rpcId));
}

// ts asc, then id asc — chronological with a deterministic tie-break.
function ascByTsId(a: MatchedLine, b: MatchedLine): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function* renderLines(
  format: AuditExportFormat,
  matched: readonly MatchedLine[],
  toolUseByRpc: ReadonlyMap<string, string>,
  sourcesByToolUse: ReadonlyMap<string, ReadonlySet<'wrapper' | 'cc-hook'>>,
): AsyncGenerator<string> {
  if (format === 'csv') {
    yield `${CSV_HEADER}\n`;
    for (const m of matched) {
      const key = effectiveToolUseId(m.event, toolUseByRpc);
      // Mismo cruce que assemble: pareja solo si el Set tiene AMBAS fuentes.
      const set = key !== undefined ? sourcesByToolUse.get(key) : undefined;
      const paired =
        set !== undefined && set.has('wrapper') && set.has('cc-hook')
          ? m.event.source === 'claude-code'
            ? 'wrapper'
            : 'cc-hook'
          : '';
      yield `${csvRow(m.event, key ?? '', paired)}\n`;
    }
  } else {
    // El JSONL raw NO cambia: línea original intacta, sin columnas nuevas.
    for (const m of matched) yield `${m.rawLine}\n`;
  }
}

export async function exportAudit(opts: AuditExportOptions): Promise<AuditExportOutcome> {
  const now = opts.now ?? Date.now();
  const files = await listJsonlFiles(opts.dir);

  const matched: MatchedLine[] = [];
  const tuples: CorrTuple[] = [];
  for (const name of files) {
    let content: string;
    try {
      content = await readFile(join(opts.dir, name), 'utf8');
    } catch {
      // EISDIR (a dir named *.jsonl), a file vanished mid-scan (purge), etc.
      // Skip it and keep going — same tolerance as readAudit.
      continue;
    }
    for (const rawLine of content.split('\n')) {
      if (rawLine.trim() === '') continue;
      // Reuse parseAuditContent per line: it yields the detection event (with
      // params intact + toolName derived) or nothing for non-detection lines
      // (mcp.response, proxy.*, self-test). The RAW line is kept untouched for
      // JSONL output.
      const event = parseAuditContent(rawLine).events[0];
      if (event === undefined) continue;
      tuples.push({
        session: event.session,
        rpcId: event.rpcId,
        type: event.type,
        ...(event.ccToolUseId !== undefined ? { ccToolUseId: event.ccToolUseId } : {}),
        ...(event.source !== undefined ? { source: event.source } : {}),
      });
      if (!matchesFilter(event, opts.filter, now)) continue;
      matched.push({ ts: event.ts, id: event.id, rawLine, event });
    }
  }
  matched.sort(ascByTsId);

  // Los mapas se computan PRE-filtro — si el filtro excluye una mitad de la
  // pareja, el paired_source de la otra sigue siendo verdad (existe en el
  // trail); computarlo solo sobre lo filtrado mentiría. Coincide con la app
  // (assemble corre sobre el trail completo).
  const toolUseByRpc = new Map<string, string>();
  for (const t of tuples) {
    if (t.ccToolUseId !== undefined) {
      toolUseByRpc.set(rpcKey(t.session, t.rpcId), t.ccToolUseId);
    }
  }
  const sourcesByToolUse = new Map<string, Set<'wrapper' | 'cc-hook'>>();
  for (const t of tuples) {
    const key = effectiveToolUseId(t, toolUseByRpc);
    if (key === undefined) continue;
    const src = t.source === 'claude-code' ? 'cc-hook' : 'wrapper';
    let set = sourcesByToolUse.get(key);
    if (!set) {
      set = new Set();
      sourcesByToolUse.set(key, set);
    }
    set.add(src);
  }

  const tmpPath = `${opts.destPath}.xcg-export.${process.pid}.tmp`;
  try {
    await pipeline(
      Readable.from(renderLines(opts.format, matched, toolUseByRpc, sourcesByToolUse)),
      createWriteStream(tmpPath, { mode: 0o600 }),
    );
    await rename(tmpPath, opts.destPath);
  } catch (err) {
    // Never leave a partial file at the destination; clean up the tmp.
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort (tmp may not have been created)
    }
    throw err;
  }

  return { count: matched.length };
}
