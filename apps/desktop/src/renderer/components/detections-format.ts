import type { Category } from '../../shared/types.js';

export const CATEGORY_LABELS: Record<Category, string> = {
  credential_detected: 'Credential leak',
  prompt_injection: 'Prompt injection',
  email_send_warning: 'Email send',
  data_export_warning: 'Data export',
  tool_call_allowed: 'Tool call',
  pii_detected: 'PII detected',
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
