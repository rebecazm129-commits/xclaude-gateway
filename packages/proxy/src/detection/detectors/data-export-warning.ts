// Data export warning detector — scans paramsJson for natural-language data
// export commands (EN / ES). Scope: TEXT branch only; inspects paramsJson.
// Emits one DetectorOutput with category 'data_export_warning' and severity
// 'medium' when any pattern matches; returns null otherwise. Findings record
// the matched type and 'params' as location — never the raw text.

import type { DetectionFinding, Detector, DetectorOutput, SelfTestExample } from '../types.js';

interface ExportPattern {
  readonly pattern: RegExp;
  readonly type: string;
}

const EXPORT_PATTERNS: readonly ExportPattern[] = [
  {
    type: 'data_export_command',
    pattern:
      /\b(?:download|export|dump|extract|save|copy)\s+(?:(?:the|all|my|all\s+my)\s+)?(?:\S+\s+){0,3}(?:database|data|files?|records?|users?|contents?|backup|table)(?:\s+(?:to|into|as|onto|in)\b)?/gi,
  },
  {
    type: 'data_export_command',
    pattern:
      /\b(?:descarga|exporta|vuelca|extrae|guarda|copia)\s+(?:(?:la|los|las|mis|todos?\s+los?|todas?\s+las?)\s+)?(?:\S+\s+){0,3}(?:base\s+de\s+datos|datos|archivos?|registros?|usuarios?|contenidos?|backup|tabla)(?:\s+(?:a|en|como|hacia)\b)?/gi,
  },
];

export const dataExportWarning: Detector = (input): DetectorOutput | null => {
  const { paramsJson } = input;
  if (paramsJson.length === 0) return null;

  const findings: DetectionFinding[] = [];
  for (const { pattern, type } of EXPORT_PATTERNS) {
    for (const _match of paramsJson.matchAll(pattern)) {
      findings.push({ type, location: 'params' });
    }
  }

  if (findings.length === 0) return null;

  return {
    category: 'data_export_warning',
    severity: 'medium',
    findings,
  };
};

export const EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'data_export_warning',
  expectedSeverity: 'medium',
  label: 'Data export',
  description: "A request asking the model to export or copy data outside its boundary.",
  message: 'export the database to a backup file',
  method: 'tools/call',
};
