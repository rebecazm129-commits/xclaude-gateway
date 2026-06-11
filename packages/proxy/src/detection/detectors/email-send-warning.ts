// Email send warning detector — two branches, both feeding ONE DetectorOutput:
//   - TEXT: scans paramsJson for natural-language email send commands (EN/ES);
//     findings type 'email_send_command' / location 'params'; tier 'high'.
//   - TOOL-NAME (tools/call only): exact-token match on the called tool's name.
//     SEND tokens (send/reply/forward) → 'email_send_tool' / tier 'high';
//     COMPOSE tokens (draft/compose) → 'email_compose_tool' / tier 'medium'.
//     Token matching only (snake/kebab/camel split) — never substring, so
//     label_message / write_file / sendai do NOT fire. 'write' is excluded on
//     purpose (write_file is legitimate and frequent).
// Findings from every firing branch are concatenated; the emitted severity is
// the highest tier among the firing branches. Returns null if nothing fires.
// Findings never carry the raw text.

import type { DetectionFinding, Detector, DetectorOutput, Severity, SelfTestExample } from '../types.js';

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

const SEND_TOKENS: readonly string[] = ['send', 'reply', 'forward'];
const COMPOSE_TOKENS: readonly string[] = ['draft', 'compose']; // 'write' excluded

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Splits a tool name into lowercase tokens across snake_case, kebab-case and
// camelCase boundaries. Matching is by EXACT token (never substring), so
// 'sendai' → ['sendai'] (no 'send'), 'write_file' → ['write','file'], etc.
function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary → space
    .split(/[_\-\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

export const emailSendWarning: Detector = (input): DetectorOutput | null => {
  const { paramsJson, toolName } = input;
  const findings: DetectionFinding[] = [];
  const tiers: Severity[] = [];

  // TEXT branch (unchanged behavior): natural-language send commands in params.
  if (paramsJson.length > 0) {
    let textFired = false;
    for (const { pattern, type } of EMAIL_SEND_PATTERNS) {
      for (const _match of paramsJson.matchAll(pattern)) {
        findings.push({ type, location: 'params' });
        textFired = true;
      }
    }
    if (textFired) tiers.push('high');
  }

  // TOOL-NAME branch (tools/call only): exact-token match on the tool name.
  if (toolName !== undefined) {
    const tokens = tokenizeToolName(toolName);
    if (SEND_TOKENS.some((t) => tokens.includes(t))) {
      findings.push({ type: 'email_send_tool', location: 'tool' });
      tiers.push('high');
    } else if (COMPOSE_TOKENS.some((t) => tokens.includes(t))) {
      findings.push({ type: 'email_compose_tool', location: 'tool' });
      tiers.push('medium');
    }
  }

  if (findings.length === 0) return null;
  // One DetectorOutput per event (the engine fans out one JSONL row per output):
  // concatenated findings + the highest tier among the firing branches.
  const severity = tiers.reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a));
  return { category: 'email_send_warning', severity, findings };
};

export const EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'email_send_warning',
  expectedSeverity: 'high',
  label: 'Email send',
  description: "A request asking the model to send an email on the user's behalf.",
  message: 'send an email to alice@example.com',
  method: 'tools/call',
};
