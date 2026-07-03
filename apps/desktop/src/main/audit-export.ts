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

export const CSV_HEADER = 'ts,mcp,type,method,tool,category,severity,findings_count';

// RFC 4180: quote a field containing comma, quote, CR or LF; double inner quotes.
function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function csvRow(e: EnrichableEvent): string {
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
  ];
  return cols.map(csvEscape).join(',');
}

// ts asc, then id asc — chronological with a deterministic tie-break.
function ascByTsId(a: MatchedLine, b: MatchedLine): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function* renderLines(
  format: AuditExportFormat,
  matched: readonly MatchedLine[],
): AsyncGenerator<string> {
  if (format === 'csv') {
    yield `${CSV_HEADER}\n`;
    for (const m of matched) yield `${csvRow(m.event)}\n`;
  } else {
    for (const m of matched) yield `${m.rawLine}\n`;
  }
}

export async function exportAudit(opts: AuditExportOptions): Promise<AuditExportOutcome> {
  const now = opts.now ?? Date.now();
  const files = await listJsonlFiles(opts.dir);

  const matched: MatchedLine[] = [];
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
      if (!matchesFilter(event, opts.filter, now)) continue;
      matched.push({ ts: event.ts, id: event.id, rawLine, event });
    }
  }
  matched.sort(ascByTsId);

  const tmpPath = `${opts.destPath}.xcg-export.${process.pid}.tmp`;
  try {
    await pipeline(
      Readable.from(renderLines(opts.format, matched)),
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
