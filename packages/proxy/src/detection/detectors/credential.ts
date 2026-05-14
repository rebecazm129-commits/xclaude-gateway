// Credential detector — scans paramsJson for known API key / token shapes.
// Emits one DetectorOutput with category 'credential_detected' and severity
// 'critical' when any pattern matches; returns null otherwise. Findings
// record the matched type and 'params' as location — never the raw secret.

import type { DetectionFinding, Detector, DetectorOutput } from '../types.js';

interface CredentialPattern {
  readonly pattern: RegExp;
  readonly type: string;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { type: 'openai_api_key',    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { type: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g },
  { type: 'github_token',      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'stripe_secret_key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { type: 'jwt_token',         pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
];

export const credentialDetected: Detector = (input): DetectorOutput | null => {
  const { paramsJson } = input;
  if (paramsJson.length === 0) return null;

  const findings: DetectionFinding[] = [];
  for (const { pattern, type } of CREDENTIAL_PATTERNS) {
    for (const _match of paramsJson.matchAll(pattern)) {
      findings.push({ type, location: 'params' });
    }
  }

  if (findings.length === 0) return null;

  return {
    category: 'credential_detected',
    severity: 'critical',
    findings,
  };
};
