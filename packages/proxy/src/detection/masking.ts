// Credential masking for the persisted audit trail (b.1). Model: Vault-style
// HMAC-SHA256 with a per-install salt (the fingerprint is verifiable only
// locally — nobody without the on-disk salt can confirm a guess), combined
// with Datadog-style partial redaction (a short clear prefix keeps the row
// recognizable) plus an irreversible hash. Deliberate first cut, capture-all:
// only credential_detected values are masked; everything else persists verbatim.
//
// Split in two: maskCredentials is PURE (no fs) and operates on the already-
// serialized event line, so it can never depend on the object shape; the salt
// helpers own the fs (baseDir/audit-salt, wx + 0o600, lazy, cached per process),
// mirroring refresh-lock's file discipline.

import { createHmac, randomBytes } from 'node:crypto';
import { openSync, readFileSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SALT_BYTES = 32;
const FP_HEX_CHARS = 16; // 64 bits
const CLEAR_PREFIX = 10;

/** 64-bit hex fingerprint of a secret under the install salt. Verifiable only
 *  by someone holding the same salt — an attacker who reads the JSONL cannot
 *  reverse it, and cannot even confirm a guessed key without the salt file. */
export function fingerprint(hmacKey: Buffer, secret: string): string {
  return createHmac('sha256', hmacKey).update(secret, 'utf8').digest('hex').slice(0, FP_HEX_CHARS);
}

function maskFor(hmacKey: Buffer, secret: string): string {
  return `${secret.slice(0, CLEAR_PREFIX)}…[fp:${fingerprint(hmacKey, secret)}]`;
}

/**
 * Replaces EVERY occurrence of each secret in an already-serialized event line
 * with `<first 10 chars>…[fp:<64-bit hex>]`. Literal split/join replace (no
 * regex, no `$` interpretation). Longest secrets first so a secret that is a
 * substring of another never corrupts the longer one's occurrences.
 *
 * The masked credential charsets ([A-Za-z0-9_.-]) are never JSON-escaped, so
 * the raw value equals its serialized form and the output stays valid JSON.
 */
export function maskCredentials(line: string, secrets: readonly string[], hmacKey: Buffer): string {
  const unique = [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let out = line;
  for (const secret of unique) {
    out = out.split(secret).join(maskFor(hmacKey, secret));
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
