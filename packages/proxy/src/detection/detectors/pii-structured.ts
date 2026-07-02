// Structured-PII detector — scans paramsJson for well-formed, checksum-backed
// PII shapes (email, IBAN, credit card, US SSN, UK NINO/NHS, Spanish DNI/NIE,
// E.164 phone, ICAO 9303 TD3 MRZ, French NIR, Italian codice fiscale, Dutch BSN,
// German Steuer-ID, Portuguese NIF). Emits one DetectorOutput with category 'pii_structured' and
// severity 'medium' when any rule matches; returns null otherwise. The regex
// PRESELECTS a candidate; the optional `validate` checksum CONFIRMS it, which
// is what keeps false positives near-zero on numeric-heavy payloads. Findings
// record only the matched type and 'params' as location — NEVER the raw datum.

import type { DetectionFinding, Detector, DetectorOutput, SelfTestExample } from '../types.js';

interface PiiRule {
  readonly type: string;
  readonly pattern: RegExp;
  // Optional post-match checksum. Receives the raw matched substring; returns
  // true to confirm the candidate. When absent, a regex match is sufficient.
  readonly validate?: (raw: string) => boolean;
}

// --- Checksum helpers (pure) ---

// Luhn (mod-10): used by credit_card after stripping separators.
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// IBAN mod-97: move first 4 chars to the end, letters -> numbers (A=10..Z=35),
// the resulting integer mod 97 must equal 1. Reduced piecewise to avoid BigInt.
function ibanValid(raw: string): boolean {
  const s = raw.replace(/[ -]/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (let i = 0; i < code.length; i++) {
      remainder = (remainder * 10 + (code.charCodeAt(i) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// US SSN validity exclusions (regex already enforced ddd-dd-dddd with hyphens):
// area 000 / 666 / 900-999 invalid, group 00 invalid, serial 0000 invalid.
function ssnValid(raw: string): boolean {
  if (!/^\d{3}-\d{2}-\d{4}$/.test(raw)) return false;
  const area = raw.slice(0, 3);
  const group = raw.slice(4, 6);
  const serial = raw.slice(7, 11);
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

// UK National Insurance number: 2 prefix letters + 6 digits + suffix A-D.
// Invalid prefix letters: D,F,I,Q,U,V (either position); second letter also
// excludes O; disallowed prefix pairs: BG,GB,NK,KN,TN,NT,ZZ.
const NINO_BAD_FIRST = 'DFIQUV';
const NINO_BAD_SECOND = 'DFIQUVO';
const NINO_BAD_PAIRS: readonly string[] = ['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ'];
function ninoValid(raw: string): boolean {
  const s = raw.replace(/ /g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{6}[A-D]$/.test(s)) return false;
  const c1 = s.charAt(0);
  const c2 = s.charAt(1);
  if (NINO_BAD_FIRST.includes(c1)) return false;
  if (NINO_BAD_SECOND.includes(c2)) return false;
  if (NINO_BAD_PAIRS.includes(c1 + c2)) return false;
  return true;
}

// UK NHS number: 10 digits, mod-11 checksum over the first 9 (weights 10..2),
// check digit = 11 - (sum mod 11); 11 -> 0, 10 -> invalid.
function nhsValid(raw: string): boolean {
  const s = raw.replace(/[ -]/g, '');
  if (!/^\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (s.charCodeAt(i) - 48) * (10 - i);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === s.charCodeAt(9) - 48;
}

// Spanish DNI: 8 digits + control letter = "TRWAGMYFPDXBNJZSQVHLCKE"[n % 23].
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
function dniValid(raw: string): boolean {
  if (!/^\d{8}[A-Za-z]$/.test(raw)) return false;
  const n = Number.parseInt(raw.slice(0, 8), 10);
  return DNI_LETTERS[n % 23] === raw.charAt(8).toUpperCase();
}

// Spanish NIE: prefix X/Y/Z + 7 digits + control letter. Same checksum as the
// DNI, mapping the prefix to a leading digit (X->0, Y->1, Z->2).
function nieValid(raw: string): boolean {
  if (!/^[XYZ]\d{7}[A-Za-z]$/i.test(raw)) return false;
  const prefix = raw.charAt(0).toUpperCase();
  const prefixDigit = prefix === 'X' ? '0' : prefix === 'Y' ? '1' : '2';
  const n = Number.parseInt(prefixDigit + raw.slice(1, 8), 10);
  return DNI_LETTERS[n % 23] === raw.charAt(8).toUpperCase();
}

// Credit card: if the candidate carries separators, require canonical grouping
// (uniform space/hyphen, 4-digit groups, last group 1-4 — e.g. #### #### #### ####);
// contiguous candidates just need 13-19 digits. Luhn applies either way. Hardening
// from the corpus probe (11/06): a /tmp/...-123-1234567890.json filename matched
// before via arbitrary separator placement plus a coincidental Luhn pass.
function creditCardValid(raw: string): boolean {
  if (/[ -]/.test(raw)) {
    if (!/^\d{4}([ -])(?:\d{4}\1)*\d{1,4}$/.test(raw)) return false;
  } else if (!/^\d{13,19}$/.test(raw)) {
    return false;
  }
  const digits = raw.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnValid(digits);
}

// --- EU/MRZ pack (Hito posterior). Each validator pre-checks its exact shape
// then runs the documented checksum (specs verified 11/06 against Wikipedia EN
// + python-stdnum docstrings; see PASO 0 report). ---

// ICAO 9303 TD3 MRZ line 2 (44 chars). Field check digits use weights 7,3,1
// (values: digit=face, A=10..Z=35, '<'=0, mod 10). Layout (0-indexed):
// 0-8 doc no, 9 dc; 10-12 nationality; 13-18 birth, 19 dc; 20 sex; 21-26 expiry,
// 27 dc; 28-41 optional, 42 dc; 43 composite dc over doc+dc, birth+dc, expiry+dc,
// optional+dc. ALL check digits (incl. composite) must pass.
function mrzCharValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  if (c === '<') return 0;
  return -1;
}
function mrzFieldCheck(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = mrzCharValue(field.charAt(i));
    if (v < 0) return -1;
    sum += v * (i % 3 === 0 ? 7 : i % 3 === 1 ? 3 : 1);
  }
  return sum % 10;
}
function mrzCheckChar(c: string): number {
  // a check-digit position holds 0-9 or '<' (empty optional field -> 0).
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c === '<') return 0;
  return -1;
}
function mrzTd3Valid(raw: string): boolean {
  if (!/^[A-Z0-9<]{44}$/.test(raw)) return false;
  const docCheck = mrzCheckChar(raw.charAt(9));
  const birthCheck = mrzCheckChar(raw.charAt(19));
  const expiryCheck = mrzCheckChar(raw.charAt(27));
  const optionalCheck = mrzCheckChar(raw.charAt(42));
  const compositeCheck = mrzCheckChar(raw.charAt(43));
  if (docCheck < 0 || birthCheck < 0 || expiryCheck < 0 || optionalCheck < 0 || compositeCheck < 0) {
    return false;
  }
  if (mrzFieldCheck(raw.slice(0, 9)) !== docCheck) return false;
  if (mrzFieldCheck(raw.slice(13, 19)) !== birthCheck) return false;
  if (mrzFieldCheck(raw.slice(21, 27)) !== expiryCheck) return false;
  if (mrzFieldCheck(raw.slice(28, 42)) !== optionalCheck) return false;
  const composite = raw.slice(0, 10) + raw.slice(13, 20) + raw.slice(21, 28) + raw.slice(28, 43);
  return mrzFieldCheck(composite) === compositeCheck;
}

// French NIR (15 chars): positions 6-7 may be 2A/2B (Corsica). Key (last 2) =
// 97 - (first-13 mod 97), with 2A->19 / 2B->18 substituted before the modulo.
// 13 digits fit in a double (< 2^53), so no BigInt.
function nirValid(raw: string): boolean {
  if (!/^[12]\d{4}(?:\d{2}|2[AB])\d{8}$/.test(raw)) return false;
  const body = raw.slice(0, 13);
  const keyStr = raw.slice(13);
  const dept = body.slice(5, 7);
  let numericBody = body;
  if (dept === '2A') numericBody = body.slice(0, 5) + '19' + body.slice(7);
  else if (dept === '2B') numericBody = body.slice(0, 5) + '18' + body.slice(7);
  if (!/^\d{13}$/.test(numericBody)) return false;
  const key = 97 - (Number.parseInt(numericBody, 10) % 97);
  return key === Number.parseInt(keyStr, 10);
}

// Italian codice fiscale (standard form; omocodia variants out of v1 scope).
// Control letter: sum odd-position (1-based) + even-position table values of the
// 15 leading chars, mod 26, mapped 0->A..25->Z. Odd table is non-linear; even is
// face value (0-9) / alphabetical index (A=0..Z=25).
const CF_ODD: readonly number[] = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
];
function cfOddValue(c: string): number {
  if (c >= '0' && c <= '9') return CF_ODD[c.charCodeAt(0) - 48] ?? -1;
  if (c >= 'A' && c <= 'Z') return CF_ODD[c.charCodeAt(0) - 65] ?? -1;
  return -1;
}
function cfEvenValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65;
  return -1;
}
function cfValid(raw: string): boolean {
  const s = raw.toUpperCase();
  if (!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z0-9]{4}[A-Z]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const v = i % 2 === 0 ? cfOddValue(s.charAt(i)) : cfEvenValue(s.charAt(i));
    if (v < 0) return false;
    sum += v;
  }
  return String.fromCharCode(65 + (sum % 26)) === s.charAt(15);
}

// Dutch BSN (9 digits) — elfproef: weights 9,8,7,6,5,4,3,2,-1; weighted sum
// divisible by 11 and non-zero (rejects 000000000).
function bsnValid(raw: string): boolean {
  if (!/^\d{9}$/.test(raw)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const weight = i < 8 ? 9 - i : -1;
    sum += (raw.charCodeAt(i) - 48) * weight;
  }
  return sum !== 0 && sum % 11 === 0;
}

// German Steuer-Identifikationsnummer (11 digits, first != 0). Check digit by
// ISO 7064 MOD 11,10 (product init 10; per digit: sum=(d+product)%10, 0->10,
// product=(sum*2)%11; check=11-product, 10->0). Plus the IdNr structural rule:
// among the first 10 digits exactly one digit appears 2 or 3 times.
function steuerCheckDigit(first10: string): number {
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (first10.charCodeAt(i) - 48 + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}
function steuerRepeatRuleOk(first10: string): boolean {
  const counts = new Map<string, number>();
  for (let i = 0; i < 10; i++) {
    const d = first10.charAt(i);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let repeated = 0;
  for (const c of counts.values()) {
    if (c > 3) return false;
    if (c === 2 || c === 3) repeated++;
  }
  return repeated === 1;
}
function steuerValid(raw: string): boolean {
  if (!/^\d{11}$/.test(raw)) return false;
  if (raw.charAt(0) === '0') return false;
  const first10 = raw.slice(0, 10);
  if (!steuerRepeatRuleOk(first10)) return false;
  return steuerCheckDigit(first10) === raw.charCodeAt(10) - 48;
}

// Portuguese NIF (9 digits). Weights 9..2 over the first 8; check = 11 - (sum%11),
// with remainder 0/1 -> check 0. First digit must be a valid type: {1,2,3,5,6,8,9}.
const PT_NIF_FIRST = '1235689';
function nifValid(raw: string): boolean {
  if (!/^\d{9}$/.test(raw)) return false;
  if (!PT_NIF_FIRST.includes(raw.charAt(0))) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (raw.charCodeAt(i) - 48) * (9 - i);
  const rem = sum % 11;
  const check = rem === 0 || rem === 1 ? 0 : 11 - rem;
  return check === raw.charCodeAt(8) - 48;
}

// --- Rule table. Order is display order of findings; correctness is order-
// independent because every rule validates its own candidate. ---
const PII_RULES: readonly PiiRule[] = [
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}\b/g,
    validate: ibanValid,
  },
  {
    type: 'credit_card',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: creditCardValid,
  },
  {
    type: 'us_ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: ssnValid,
  },
  {
    type: 'uk_nino',
    pattern: /\b[A-Za-z]{2}(?:[ ]?\d){6}[ ]?[A-Za-z]\b/g,
    validate: ninoValid,
  },
  {
    type: 'uk_nhs',
    pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g,
    validate: nhsValid,
  },
  {
    type: 'es_dni',
    pattern: /\b\d{8}[A-Za-z]\b/g,
    validate: dniValid,
  },
  {
    type: 'es_nie',
    pattern: /\b[XYZ]\d{7}[A-Za-z]\b/g,
    validate: nieValid,
  },
  {
    type: 'mrz_td3',
    pattern: /(?<![A-Z0-9<])[A-Z0-9<]{44}(?![A-Z0-9<])/g,
    validate: mrzTd3Valid,
  },
  {
    type: 'fr_nir',
    pattern: /\b[12]\d{4}(?:\d{2}|2[AB])\d{8}\b/g,
    validate: nirValid,
  },
  {
    type: 'it_codice_fiscale',
    pattern: /\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z0-9]{4}[A-Za-z]\b/g,
    validate: cfValid,
  },
  // nl_bsn and pt_nif share the exact 9-digit shape (\b\d{9}\b). A value that
  // satisfies BOTH checksums (the Dutch elfproef AND the Portuguese mod-11) is
  // emitted as TWO findings — one per type — on purpose. A bare 9-digit number
  // carries no country context, so the detector reports every checksum it
  // passes (multi-label, like the request side) rather than guessing one. This
  // is deliberate, NOT a de-dup bug: collapsing the pair would hide a real
  // ambiguity, which an audit tool must surface, not resolve. The behavior is
  // pinned in tests/detectors/pii-structured.test.ts ("multi-label").
  {
    type: 'nl_bsn',
    pattern: /\b\d{9}\b/g,
    validate: bsnValid,
  },
  {
    type: 'de_steuer_id',
    pattern: /\b\d{11}\b/g,
    validate: steuerValid,
  },
  {
    type: 'pt_nif',
    pattern: /\b\d{9}\b/g,
    validate: nifValid,
  },
  {
    type: 'phone_e164',
    pattern: /\+\d(?:[ -]?\d){7,14}\b/g,
  },
];

export const piiStructured: Detector = (input): DetectorOutput | null => {
  const { paramsJson } = input;
  if (paramsJson.length === 0) return null;

  const findings: DetectionFinding[] = [];
  for (const { pattern, type, validate } of PII_RULES) {
    for (const match of paramsJson.matchAll(pattern)) {
      if (validate !== undefined && !validate(match[0])) continue;
      findings.push({ type, location: 'params' });
    }
  }

  if (findings.length === 0) return null;

  return {
    category: 'pii_structured',
    severity: 'medium',
    findings,
  };
};

export const EXAMPLE_PAYLOAD: SelfTestExample = {
  categoryKey: 'pii_structured',
  expectedSeverity: 'medium',
  label: 'Structured PII',
  description: "A checksum-valid identifier (e.g. an email) embedded in a tool call argument.",
  message: 'please reach me at alice@example.com',
  method: 'tools/call',
};
