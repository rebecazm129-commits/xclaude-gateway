// Baseline lifecycle history, read on demand for one connector's card.
//
// WHY THIS IS NOT A DETECTION FEED. These events say what the AUDITOR did to
// its own state: started tracking a section, upgraded a baseline, recomputed
// its own projection, repaired a damaged file. None of that is something a
// connector did, so none of it belongs in Detections, in the tray count, or in
// any flagged counter — putting it there would inflate exactly the number the
// user reads as "things worth looking at".
//
// Two of them ARE worth surfacing as warnings, because they mean the auditor
// could not do its job: a snapshot it could not assemble, and a baseline file
// it wrote itself and could no longer read.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listJsonlFiles } from './detection-reader.js';

export const BASELINE_EVENT_TYPE = 'app.manifest_baseline';

export type BaselineEventKind =
  | 'section_initialized'
  | 'migrated'
  | 'projection_migrated'
  | 'reseeded'
  | 'snapshot_incomplete';

export interface BaselineHistoryEntry {
  ts: string;
  mcp: string;
  event: BaselineEventKind;
  section?: string;
  reason?: string;
  coverageExpanded?: string[];
  fromVersion?: number;
  toVersion?: number;
}

/** The two that mean the auditor could not do its job. Everything else is
 *  history, not a problem. */
export function isBaselineWarning(e: BaselineHistoryEntry): boolean {
  return e.event === 'snapshot_incomplete' || (e.event === 'reseeded' && e.reason === 'corrupt');
}

const KINDS = new Set<string>([
  'section_initialized',
  'migrated',
  'projection_migrated',
  'reseeded',
  'snapshot_incomplete',
]);

function parseLine(line: string): BaselineHistoryEntry | null {
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d === null || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (o['type'] !== BASELINE_EVENT_TYPE) return null;
  const event = o['event'];
  if (typeof event !== 'string' || !KINDS.has(event)) return null;
  if (typeof o['mcp'] !== 'string' || typeof o['ts'] !== 'string') return null;
  const entry: BaselineHistoryEntry = {
    ts: o['ts'],
    mcp: o['mcp'],
    event: event as BaselineEventKind,
  };
  if (typeof o['section'] === 'string') entry.section = o['section'];
  if (typeof o['reason'] === 'string') entry.reason = o['reason'];
  if (Array.isArray(o['coverageExpanded'])) {
    entry.coverageExpanded = o['coverageExpanded'].filter((x): x is string => typeof x === 'string');
  }
  if (typeof o['fromVersion'] === 'number') entry.fromVersion = o['fromVersion'];
  if (typeof o['toVersion'] === 'number') entry.toVersion = o['toVersion'];
  return entry;
}

/**
 * Every baseline event for one connector, newest first, capped.
 *
 * Read on demand rather than folded into the audit store: this is card detail,
 * not something the 2s poll or the tray needs, and keeping it out of that path
 * is what guarantees it can never reach a counter.
 */
export async function readBaselineHistory(
  dir: string,
  mcp: string,
  limit = 50,
): Promise<BaselineHistoryEntry[]> {
  const out: BaselineHistoryEntry[] = [];
  let files: string[];
  try {
    files = await listJsonlFiles(dir);
  } catch {
    return [];
  }
  for (const name of files) {
    let content: string;
    try {
      content = await readFile(join(dir, name), 'utf8');
    } catch {
      continue; // an unreadable session file must not lose the others
    }
    // Cheap pre-filter: most session files carry none of these at all.
    if (!content.includes(BASELINE_EVENT_TYPE)) continue;
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      const entry = parseLine(line);
      if (entry !== null && entry.mcp === mcp) out.push(entry);
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out.slice(0, limit);
}
