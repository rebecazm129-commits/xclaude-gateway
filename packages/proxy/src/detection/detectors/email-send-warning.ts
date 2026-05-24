// Email send warning detector — scans paramsJson for natural-language email
// send commands (EN / ES). Scope strictly limited to the TEXT branch:
// inspects paramsJson only; never toolName or MCP name. The tool-call branch
// (detecting via MCP/tool-name matching) is deferred to Milestone 5.
// Emits one DetectorOutput with category 'email_send_warning' and severity
// 'high' when any pattern matches; returns null otherwise. Findings record
// the matched type and 'params' as location — never the raw text.

import type { DetectionFinding, Detector, DetectorOutput, SelfTestExample } from '../types.js';

interface EmailSendPattern {
  readonly pattern: RegExp;
  readonly type: string;
}

const EMAIL_SEND_PATTERNS: readonly EmailSendPattern[] = [
  {
    type: 'email_send_command',
    pattern:
      /\b(?:send|compose|draft|write)\s+(?:(?:an?|the|this|that|my|your|his|her|our|their)\s+)?(?:email|mail|message)\s+(?:to|for|saying|that\s+says)\b/gi,
  },
  {
    type: 'email_send_command',
    pattern:
      /\b(?:envía|envia|manda|redacta|escribe)\s+(?:(?:un|una|el|la|los|las|este|esta|ese|esa|mi|tu|su|nuestro|nuestra|vuestro|vuestra)\s+)?(?:correo|email|mensaje|mail)\s+(?:a|para|que\s+diga|diciendo)\b/gi,
  },
];

export const emailSendWarning: Detector = (input): DetectorOutput | null => {
  const { paramsJson } = input;
  if (paramsJson.length === 0) return null;

  const findings: DetectionFinding[] = [];
  for (const { pattern, type } of EMAIL_SEND_PATTERNS) {
    for (const _match of paramsJson.matchAll(pattern)) {
      findings.push({ type, location: 'params' });
    }
  }

  if (findings.length === 0) return null;

  return {
    category: 'email_send_warning',
    severity: 'high',
    findings,
  };
};

export const EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'email_send_warning',
  expectedSeverity: 'high',
  label: 'Email send',
  description: "A request asking the model to send an email on the user's behalf.",
  payload: { instruction: 'send an email to alice@example.com' },
  method: 'tools/call',
};
