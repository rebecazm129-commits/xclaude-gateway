import type { Category, Severity, SourceKind } from '../../shared/types.js';

// Shared by the Source filter pill (Detections) and the DetailDrawer line.
export const SOURCE_LABELS: Record<SourceKind, string> = {
  gateway: 'Gateway',
  'claude-code': 'Claude Code',
};

// Shared by the paired-badge tooltip (DetectionRow) and the DetailDrawer
// correlation line. Keyed by pairedSource: the value names the OTHER source
// that also recorded the same tool-use (frente 3).
export const PAIRED_SOURCE_LABELS: Record<'wrapper' | 'cc-hook', string> = {
  'cc-hook': 'Also recorded by the Claude Code hook',
  wrapper: 'Also recorded by the wrapper',
};

// Tool-column contract: show the closest thing to the wire we can NAME —
// real tool > real method > synthetic label only when nothing real exists.
// Requests have a tool/method; tool_manifest_changed enrichments ride the
// tools/list response (labeled with that method, in DetectionRow). Only the
// remaining enrichments get a synthetic bracket label here, derived from
// category — never a blind literal: pii_detected is emitted ONLY by the async
// NER worker; everything else is inline content classification over a
// result/error text (wrapper inbound or Claude Code).
export function enrichmentToolLabel(category: Category): string {
  return category === 'pii_detected' ? '[NER]' : '[content]';
}

export const CATEGORY_LABELS: Record<Category, string> = {
  credential_detected: 'Credential leak',
  prompt_injection: 'Prompt injection',
  email_send_warning: 'Email send',
  data_export_warning: 'Data export',
  tool_call_allowed: 'Tool call',
  pii_detected: 'PII detected',
  pii_structured: 'Structured PII',
  tool_manifest_changed: 'Tool manifest changed',
};

// Baseline rows whose method is NOT tools/call used to render as "Tool call".
// That is a lie on 6,132 rows of the production trail (initialize 2,705,
// tools/list 2,177, resources/list 661, prompts/list 588, resources/read 1),
// and it degrades silently: in the 2026-07-28 compatibility probe the new
// discovery RPC `server/discover` also came through labelled "Tool call".
//
// The method has its own column already (DetectionRow: row.toolName ?? row.method),
// so repeating it here would duplicate rather than inform. This names the CLASS
// of row truthfully instead: a protocol call that was observed and not flagged.
export function categoryLabel(category: Category, method?: string): string {
  if (category === 'tool_call_allowed' && method !== undefined && method !== 'tools/call') {
    return 'Protocol call';
  }
  return CATEGORY_LABELS[category];
}

// What the SEVERITY column shows. Normal activity — tool_call_allowed, both
// "Tool call" and "Protocol call" — is NONE: nothing matched, the bottom of
// the scale. The trail keeps the `low` the engine writes on those lines; this is
// a reading of the category, done here and nowhere else, so the two list
// views and the panel header cannot disagree about it.
export function displaySeverity(row: { category: Category; severity: Severity }): Severity | 'none' {
  return row.category === 'tool_call_allowed' ? 'none' : row.severity;
}

const MONTH_SHORT: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, '0');
  const month = MONTH_SHORT[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}:${ss}`;
}
