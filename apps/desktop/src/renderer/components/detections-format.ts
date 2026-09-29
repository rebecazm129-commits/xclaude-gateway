import type { Category, ElicitationAction, ElicitationUrlView, Severity, SourceKind } from '../../shared/types.js';
import { ELICITATION_METHOD } from '../../shared/types.js';

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
// NER worker; protocol_tripwire only by the proxy's response branch (a result's
// resultType, not its text — "[content]" would say the opposite of what it
// read); everything else is inline content classification over a result/error
// text (wrapper inbound or Claude Code).
export function enrichmentToolLabel(category: Category): string {
  if (category === 'pii_detected') return '[NER]';
  if (category === 'protocol_tripwire') return '[protocol]';
  return '[content]';
}

export const CATEGORY_LABELS: Record<Category, string> = {
  credential_detected: 'Credential leak',
  prompt_injection: 'Prompt injection',
  email_send_warning: 'Email send',
  data_export_warning: 'Data export',
  tool_call_allowed: 'Tool call',
  pii_detected: 'PII detected',
  pii_structured: 'Structured PII',
  protocol_tripwire: 'Protocol tripwire',
  audit_trail_modification: 'Audit trail modification',
  tool_manifest_changed: 'Tool manifest changed',
};

/** What an audit_trail_modification finding says, one sentence per kind of
 *  operation found (write, delete), in that order. Empty for any other
 *  category. */
export function auditTrailSentences(
  category: Category,
  findings: readonly { type: string }[],
): string[] {
  if (category !== 'audit_trail_modification') return [];
  const ops = (['write', 'delete'] as const).filter((op) => findings.some((f) => f.type === op));
  return ops.map((op) => `Tool call targeted xCLAUDE audit data with a ${op} operation`);
}

/** A Claude Code elicitation row: an MCP server asking the user for input. */
export function isElicitationRow(row: { method?: string; source?: string }): boolean {
  return row.method === ELICITATION_METHOD && row.source === 'claude-code';
}

/** What the TOOL column shows for an elicitation row, instead of the method. */
export const ELICITATION_TOOL_LABEL = 'Server requested input';

// What the user did with an MCP server's elicitation. Never "completed":
// accepting only means the user answered (or, in url mode, agreed to open the
// page) — what happened next is not something the hook sees.

/** The DETAILS prefix: the action, then the mode and message it answers. */
export function elicitationRowPrefix(action: ElicitationAction): string {
  switch (action) {
    case 'accept':
      return 'User accepted';
    case 'decline':
      return 'User declined';
    case 'cancel':
      return 'User cancelled';
  }
}

/** The panel's "User action" value. */
export function elicitationActionLabel(action: ElicitationAction): string {
  switch (action) {
    case 'accept':
      return 'Accepted';
    case 'decline':
      return 'Declined';
    case 'cancel':
      return 'Cancelled';
  }
}

export const ELICITATION_NO_ACTION = 'No user response was observed by xCLAUDE.';
export const ELICITATION_VALUES_NOT_STORED = 'xCLAUDE does not store the values entered by the user.';
export const ELICITATION_SECRET_NOTE =
  'This form appears to request a secret. MCP does not allow sensitive credentials in form elicitation; they should be requested via URL mode.';

/** The warning flags of an elicitation URL, one short sentence each. */
export function elicitationUrlFlags(url: ElicitationUrlView): string[] {
  const out: string[] = [];
  if (url.unparseable === true) out.push('The URL could not be parsed');
  if (url.nonHttps === true) out.push('Not HTTPS');
  if (url.hadUserinfo === true) out.push('The URL carried a username or password (not kept)');
  if (url.punycodeHost === true) out.push('The host uses internationalized characters (punycode)');
  if (url.hadFragment === true) out.push('The URL had a fragment (not kept)');
  return out;
}

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
