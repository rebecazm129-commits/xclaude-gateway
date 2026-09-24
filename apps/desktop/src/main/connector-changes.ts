// Reading connector changes in BOTH formats, without rewriting a byte of the
// trail.
//
// Native lines are mcp.connector_change. Everything recorded before the facts
// model is an mcp.detection_enrichment carrying detection.category ===
// 'tool_manifest_changed' — 317 of them in the operator's own trail at the time
// of writing, spanning four months. They are reconstructed into the same view
// so one reader serves both, and marked source_format so a consumer never
// mistakes a reconstruction for a native record.
//
// WHAT A RECONSTRUCTION CANNOT SAY, and therefore does not:
//   - snapshot. The old line carried no hashes, so it is null. That is also
//     why a historical change can never be re-judged by a later heuristic:
//     there is nothing to measure against.
//   - rule_version. These findings predate versioning, so they carry 0, which
//     reads as "emitted before rules were versioned" rather than as version 1,
//     which would be a lie about which rule decided.
//   - external_url / imperative_language / external_ref. These were
//     informational findings that never raised severity and have no place in
//     either list of the facts model. They are dropped from the view and
//     remain, untouched, in the raw trail line.
//
// WHAT THE HISTORY ACTUALLY HOLDS, measured over the operator's own trail on
// 24/09: 317 manifest lines, and ZERO security-rule findings among them. Every
// finding ever written is a shape one (schema_changed 325, description_changed
// 266, tool_added 186, surface_added 92, tool_removed 76) plus six
// informational. The 91 lines graded `high` were graded by the pre-shape rule
// retired on 24/09, not by a rule finding — so that severity has no
// representation here, and deliberately none: it was retired because it was
// wrong, and carrying it forward would launder a judgement we stopped trusting.
//
// The consequence is worth stating plainly: every reconstructed event lands in
// Changes and none in Detections. The 20 events that DO carry
// sensitive_param_added come from replaying today's detector over the raw
// tools/list responses, which is a different thing from what the trail records.
//
// Per-finding severity did not exist before the model: the old line carried one
// severity for the whole event. Rather than stamp that maximum onto every
// finding (overstating the small ones) or re-grade with today's rules
// (re-judging the past), each finding gets the severity its rule meant AT
// EMISSION TIME, which is fixed and, for hidden_characters, recoverable from
// the line's own class field.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CONNECTOR_CHANGE_TYPE,
  type Attention,
  type ChangeKind,
  type ConnectorChangeEntry,
  type ConnectorFinding,
  type ConnectorSection,
  type RuleId,
  type SnapshotRef,
} from '@xcg/shared';

import { listJsonlFiles } from './detection-reader.js';

/** One change as the UI and the export see it, whatever format it came from. */
export interface ConnectorChangeView {
  event_id: string;
  ts: string;
  mcp: string;
  section: ConnectorSection;
  snapshot: SnapshotRef | null;
  changes: ConnectorChangeEntry[];
  findings: ConnectorFinding[];
  attention: Attention;
  source_format?: 'tool_manifest_changed_v1';
}

const LEGACY_TYPE = 'mcp.detection_enrichment';
const LEGACY_CATEGORY = 'tool_manifest_changed';

/** Old finding type → what moved. Anything absent here is not a change. */
const CHANGE_OF: Readonly<Record<string, ChangeKind>> = {
  tool_added: 'item_added',
  tool_removed: 'item_removed',
  description_changed: 'description_changed',
  surface_added: 'surface_added',
  schema_changed: 'schema_changed',
};

const RULE_OF = new Set<string>([
  'sensitive_param_added',
  'sensitive_path_reference',
  'injection_marker',
  'hidden_characters',
]);

/** Version stamped on findings that predate rules.ts. Never 1: a reader must be
 *  able to tell "before versioning" from "version one". */
export const UNVERSIONED = 0;

/** Hidden-character classes that meant high when these lines were written. */
const HIGH_HIDDEN_CLASSES = new Set(['tag', 'bidi']);

function legacySeverity(type: string, rule: string | undefined): ConnectorFinding['severity'] {
  if (type === 'hidden_characters') {
    return rule !== undefined && HIGH_HIDDEN_CLASSES.has(rule) ? 'high' : 'medium';
  }
  return 'high';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** A legacy enrichment line → the same view a native line produces. */
export function fromLegacyLine(value: unknown): ConnectorChangeView | null {
  if (!isRecord(value) || value['type'] !== LEGACY_TYPE) return null;
  const det = value['detection'];
  if (!isRecord(det) || det['category'] !== LEGACY_CATEGORY) return null;
  const id = value['id'];
  const ts = value['ts'];
  const mcp = value['mcp'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof mcp !== 'string') return null;

  const changes: ConnectorChangeEntry[] = [];
  const findings: ConnectorFinding[] = [];
  const raw = Array.isArray(det['findings']) ? det['findings'] : [];
  for (const f of raw) {
    if (!isRecord(f) || typeof f['type'] !== 'string') continue;
    const type = f['type'];
    const location = typeof f['location'] === 'string' ? f['location'] : '';
    const path = typeof f['path'] === 'string' ? f['path'] : undefined;
    const rule = typeof f['rule'] === 'string' ? f['rule'] : undefined;
    const kind = CHANGE_OF[type];
    if (kind !== undefined) {
      changes.push({ kind, target: location, ...(path !== undefined ? { path } : {}) });
      continue;
    }
    if (!RULE_OF.has(type)) continue; // informational: not a change, not a verdict
    const evidence: ConnectorFinding['evidence'] = {};
    // sensitive_param_added put `tool.param` in location; the tool is the part
    // before the first dot, which is how it was written.
    if (location !== '') {
      evidence.target = type === 'sensitive_param_added' ? location.split('.')[0]! : location;
      if (type === 'sensitive_param_added') evidence.path = location;
    }
    if (path !== undefined) evidence.path = path;
    if (rule !== undefined) evidence.rule = rule;
    if (typeof f['codepoint'] === 'string') evidence.codepoint = f['codepoint'];
    if (typeof f['count'] === 'number') evidence.count = f['count'];
    findings.push({
      rule_id: type as RuleId,
      rule_version: UNVERSIONED,
      severity: legacySeverity(type, rule),
      evidence,
    });
  }
  if (changes.length === 0 && findings.length === 0) return null;
  return {
    event_id: id,
    ts,
    mcp,
    section: 'tools', // the only section the old detector ever watched
    snapshot: null,
    changes,
    findings,
    attention: { level: 'normal' },
    source_format: 'tool_manifest_changed_v1',
  };
}

/** A native mcp.connector_change line → the view, unchanged. */
export function fromNativeLine(value: unknown): ConnectorChangeView | null {
  if (!isRecord(value) || value['type'] !== CONNECTOR_CHANGE_TYPE) return null;
  const id = value['id'];
  const ts = value['ts'];
  const mcp = value['mcp'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof mcp !== 'string') return null;
  if (!Array.isArray(value['changes']) || !Array.isArray(value['findings'])) return null;
  const section = value['section'];
  const attention = value['attention'];
  return {
    event_id: id,
    ts,
    mcp,
    section: (typeof section === 'string' ? section : 'tools') as ConnectorSection,
    snapshot: (value['snapshot'] ?? null) as SnapshotRef | null,
    changes: value['changes'] as ConnectorChangeEntry[],
    findings: value['findings'] as ConnectorFinding[],
    attention: (isRecord(attention) ? attention : { level: 'normal' }) as Attention,
  };
}

/** Either format, or null when the line is neither. */
export function viewOfLine(line: string): ConnectorChangeView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return fromNativeLine(parsed) ?? fromLegacyLine(parsed);
}

/**
 * Every connector change in the trail, newest first.
 *
 * Read on demand like the baseline history, not folded into the 2s audit poll:
 * these feed a view the user opens, and keeping them off that path is what
 * guarantees they can never reach a counter by accident.
 */
export async function readConnectorChanges(
  dir: string,
  opts: { mcp?: string; limit?: number } = {},
): Promise<ConnectorChangeView[]> {
  const limit = opts.limit ?? 500;
  const out: ConnectorChangeView[] = [];
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
    // Cheap pre-filter: most session files carry neither format.
    if (!content.includes(CONNECTOR_CHANGE_TYPE) && !content.includes(LEGACY_CATEGORY)) continue;
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      const view = viewOfLine(line);
      if (view === null) continue;
      if (opts.mcp !== undefined && view.mcp !== opts.mcp) continue;
      out.push(view);
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out.slice(0, limit);
}
