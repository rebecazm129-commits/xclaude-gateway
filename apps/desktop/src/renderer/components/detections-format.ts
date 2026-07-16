import type { Category, SourceKind } from '../../shared/types.js';

// Shared by the Source filter pill (Detections) and the DetailDrawer line.
export const SOURCE_LABELS: Record<SourceKind, string> = {
  gateway: 'Gateway',
  'claude-code': 'Claude Code',
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
