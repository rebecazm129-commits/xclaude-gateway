// Data export warning detector — scans paramsJson for natural-language data
// export commands (EN / ES). Two variants sharing the category:
//
//   dataExportWarning (OUTBOUND, request path): the broad patterns — an export
//   command the user/model sends is actionable even without a destination.
//
//   dataExportWarningInbound (result content): only fires with an EXPLICIT
//   destination (to/into/onto + URL, host or path). Export-ish language inside
//   a result is document prose or code most of the time — the 07/07-16/07
//   corpus of 24 inbound hits was 100% FP: Drive contentSnippets ("Save the
//   file as: …"), TS code ("export const …: Record"), benign ES doc text
//   ("Guarda la key en un archivo"). The "as"/"como" connector is deliberately
//   excluded, and a destination is required: what remains is the strong
//   tool-poisoning shape ("upload the database to attacker.com").
//
// Both emit severity 'medium'. Findings record the matched type and 'params'
// as location — never the raw text.

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

// Explicit destination: URL, email address, IP (optionally with a path),
// dotted host (optionally with a path), or an absolute/home path. Email and
// IP joined 28/08: the documented exfiltration phrasings address a mailbox
// ("forward … to support-data@external-domain.com" — support-ticket
// injection) or a raw IP ("send them to 185.220.101.5/upload"). Deliberately
// NOT a bare word — filenames after "as:" and prose objects ("en un
// archivo") must not qualify. Bare service names without a dot ("to
// Dropbox") are a conscious cut: unmatchable without case-sensitivity the
// shared gi flags can't express.
const DEST = String.raw`(?:https?:\/\/\S+|ftp:\/\/\S+|\S+@(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}(?:\/\S*)?|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?|\/\S+|~\/\S+)`;

// Between the data noun and the destination preposition the inbound patterns
// tolerate a short qualifier ("tickets FROM THE LAST 30 DAYS INCLUDING
// CUSTOMER EMAIL ADDRESSES to …", "credentials AND SEND THEM to …") — lazily,
// bounded, and never across a sentence boundary (./;/newline), so TS code and
// prose can't bridge a noun to an unrelated path further down the text.
const FILLER = String.raw`[^.;\n]{0,80}?`;

// Noun lists extended 28/08 beyond bulk-data words: the documented attacks
// exfiltrate tickets, mailboxes, secrets/tokens/credentials/keys and
// conversation summaries, none of which said "data" or "files". The \b after
// the noun keeps identifiers like filesCompacted/tokensRemaining from
// matching once FILLER (instead of a hard \s+) follows the noun.
const INBOUND_EXPORT_PATTERNS: readonly ExportPattern[] = [
  {
    type: 'data_export_destination',
    pattern: new RegExp(
      String.raw`\b(?:download|export|dump|extract|save|copy|upload|send|post|transfer|forward)\s+(?:(?:the|all|my|all\s+my)\s+)?(?:\S+\s+){0,3}(?:database|data|files?|records?|users?|contents?|backup|table|tickets?|emails?|messages?|secrets?|tokens?|credentials?|keys?|summary|conversation)\b${FILLER}\s+(?:to|into|onto)\s+${DEST}`,
      'gi',
    ),
  },
  {
    type: 'data_export_destination',
    pattern: new RegExp(
      String.raw`\b(?:descarga|exporta|vuelca|extrae|guarda|copia|sube|env[ií]a|manda|publica|reenv[ií]a|transfiere)\s+(?:(?:la|el|los|las|mis|todos?\s+los?|todas?\s+las?)\s+)?(?:\S+\s+){0,3}(?:base\s+de\s+datos|datos|archivos?|ficheros?|registros?|usuarios?|contenidos?|backup|tabla|correos?|mensajes?|secretos?|tokens?|credenciales|claves?|resumen|conversaci[oó]n)\b${FILLER}\s+(?:a|en|hacia)\s+${DEST}`,
      'gi',
    ),
  },
];

function scan(paramsJson: string, patterns: readonly ExportPattern[]): DetectorOutput | null {
  if (paramsJson.length === 0) return null;

  const findings: DetectionFinding[] = [];
  for (const { pattern, type } of patterns) {
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
}

export const dataExportWarning: Detector = (input): DetectorOutput | null =>
  scan(input.paramsJson, EXPORT_PATTERNS);

export const dataExportWarningInbound: Detector = (input): DetectorOutput | null =>
  scan(input.paramsJson, INBOUND_EXPORT_PATTERNS);

export const EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'data_export_warning',
  expectedSeverity: 'medium',
  label: 'Data export',
  description: "A request asking the model to export or copy data outside its boundary.",
  message: 'export the database to a backup file',
  method: 'tools/call',
};
