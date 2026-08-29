// Credential masking for the persisted audit trail (b.1). Model: Vault-style
// HMAC-SHA256 with a per-install salt (the fingerprint is verifiable only
// locally — nobody without the on-disk salt can confirm a guess), combined
// with FULL redaction of the value (29/08): standard practice redacts API
// keys completely — unlike cards, where a partial mask serves a human who
// needs the context — because a printed prefix shrinks the search space and
// survives later re-redactions. The non-secret identifier that used to be the
// job of a 10-char clear prefix is the match's TYPE (anthropic_api_key,
// aws_access_key_id, …), which the mask prints instead. Capture-all
// otherwise: only credential_detected values are masked; everything else
// persists verbatim.
//
// Split in two: maskCredentials is PURE (no fs) and operates on the already-
// serialized event line, so it can never depend on the object shape; the salt
// helpers own the fs (baseDir/audit-salt, wx + 0o600, lazy, cached per process),
// mirroring refresh-lock's file discipline.

import { createHmac, randomBytes } from 'node:crypto';
import { openSync, readFileSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CredentialMatch } from './detectors/credential.js';

const SALT_BYTES = 32;
const FP_HEX_CHARS = 16; // 64 bits

/** 64-bit hex fingerprint of a secret under the install salt. Verifiable only
 *  by someone holding the same salt — an attacker who reads the JSONL cannot
 *  reverse it, and cannot even confirm a guessed key without the salt file. */
export function fingerprint(hmacKey: Buffer, secret: string): string {
  return createHmac('sha256', hmacKey).update(secret, 'utf8').digest('hex').slice(0, FP_HEX_CHARS);
}

function maskFor(hmacKey: Buffer, secret: string, type: string): string {
  return `[credential:${type} fp:${fingerprint(hmacKey, secret)}]`;
}

/**
 * Replaces EVERY occurrence of each matched secret in an already-serialized
 * event line with `[credential:<type> fp:<64-bit hex>]`. NO character of the
 * value survives (29/08 rule — see the header). Literal split/join replace
 * (no regex, no `$` interpretation). Longest secrets first so a secret that
 * is a substring of another never corrupts the longer one's occurrences.
 *
 * JSON-safety: the masked credential charsets ([A-Za-z0-9_.-]) are never
 * JSON-escaped, so the raw value equals its serialized form; the replacement
 * itself is plain ASCII with no quote or backslash (`type` is a snake_case
 * identifier, `fp` is hex), so the output stays valid JSON.
 */
export function maskCredentials(
  line: string,
  matches: readonly CredentialMatch[],
  hmacKey: Buffer,
): string {
  // Dedupe by value (first pattern wins — CREDENTIAL_PATTERNS are disjoint),
  // then longest-first, as before.
  const typeByValue = new Map<string, string>();
  for (const m of matches) {
    if (m.value.length > 0 && !typeByValue.has(m.value)) typeByValue.set(m.value, m.type);
  }
  const ordered = [...typeByValue.keys()].sort((a, b) => b.length - a.length);
  let out = line;
  for (const value of ordered) {
    out = out.split(value).join(maskFor(hmacKey, value, typeByValue.get(value)!));
  }
  return out;
}

// --- salt (fs) ----------------------------------------------------------------

export function auditSaltPath(baseDir: string): string {
  return join(baseDir, 'audit-salt');
}

let cachedKey: Buffer | null = null;

/**
 * Loads (or creates) the per-install audit salt at baseDir/audit-salt. 32
 * random bytes, wx + 0o600, lazy. A wx→EEXIST race (two wrappers starting at
 * once) re-reads the winner's file, so all processes converge to ONE salt and
 * fingerprints stay stable across processes. May throw on a genuine fs error
 * (disk full, perms) — the caller (resolveAuditKey) turns that into the
 * ephemeral fallback. Caches the salt per process.
 */
export function loadOrCreateAuditSalt(baseDir: string): Buffer {
  if (cachedKey !== null) return cachedKey;
  const path = auditSaltPath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      const salt = randomBytes(SALT_BYTES);
      writeSync(fd, salt);
      cachedKey = salt;
      return salt;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lost the create race (or a prior run made it): read the existing salt.
    cachedKey = readFileSync(path);
    return cachedKey;
  }
}

/**
 * The key EventSink uses. NEVER throws: if the salt cannot be loaded/created,
 * falls back to a process-ephemeral random key so a detected credential is
 * still masked before it hits disk (a clear-text persist is the one outcome we
 * refuse). Trade-off: ephemeral fingerprints are stable WITHIN this process but
 * differ across processes/restarts — accepted; masking-before-persist wins over
 * cross-process fingerprint stability. Logged to stderr for triage.
 */
export function resolveAuditKey(baseDir: string): Buffer {
  try {
    return loadOrCreateAuditSalt(baseDir);
  } catch (err) {
    if (cachedKey === null) cachedKey = randomBytes(SALT_BYTES);
    process.stderr.write(
      `xcg-proxy: audit salt unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        `using an ephemeral key — credential fingerprints won't be stable across processes.\n`,
    );
    return cachedKey;
  }
}

/** Test seam: the per-process salt cache survives between vitest cases. */
export function resetAuditKeyForTests(): void {
  cachedKey = null;
}
