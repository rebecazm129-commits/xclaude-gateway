// Tests for credential masking (masking.ts): the pure maskCredentials replacer,
// the fingerprint, and the salt lifecycle (lazy create, race convergence,
// ephemeral fallback). Salt tests use a temp baseDir; the real Application
// Support tree is never touched.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditSaltPath,
  fingerprint,
  loadOrCreateAuditSalt,
  maskCredentials,
  resetAuditKeyForTests,
  resolveAuditKey,
} from '../src/detection/masking.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const SK = `sk-proj-${'A'.repeat(40)}`;
const GH = `ghp_${'B'.repeat(40)}`;

const tmpDirs: string[] = [];
function tempBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-salt-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => resetAuditKeyForTests());
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetAuditKeyForTests();
});

// Full-redaction contract (29/08): NO character of the secret may reach the
// masked line — the mask identifies the FORMAT (the finding's type) plus the
// HMAC fingerprint, never a prefix of the value. One case per credential.ts
// pattern, including the 20-char AWS id (where a 10-char prefix used to be
// half the whole value) and a JWT.
const FORMAT_CASES: ReadonlyArray<{ type: string; secret: string }> = [
  { type: 'anthropic_api_key', secret: `sk-ant-api03-${'A'.repeat(40)}` },
  { type: 'openai_api_key',    secret: `sk-proj-${'B'.repeat(40)}` },
  { type: 'aws_access_key_id', secret: `AKIA${'C'.repeat(16)}` },
  { type: 'github_token',      secret: `ghp_${'D'.repeat(36)}` },
  { type: 'stripe_secret_key', secret: `sk_test_${'E'.repeat(24)}` },
  { type: 'jwt_token',         secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' },
];

describe('maskCredentials — full redaction per format (29/08)', () => {
  for (const { type, secret } of FORMAT_CASES) {
    it(`${type}: no fragment of the secret survives; mask carries type + fp`, () => {
      const line = JSON.stringify({ a: `key=${secret} end`, b: 'clean' });
      const out = maskCredentials(line, [{ value: secret, type }], KEY);
      expect(out).not.toContain(secret);
      // The old 10-char clear prefix must be gone too — not even the first
      // characters of the value may print.
      expect(out).not.toContain(secret.slice(0, 10));
      expect(out).not.toContain(secret.slice(0, 4));
      expect(out).toContain(`[credential:${type} fp:${fingerprint(KEY, secret)}]`);
      // JSON-safety: the literal substitution must leave the line parseable.
      const parsed = JSON.parse(out) as { a: string; b: string };
      expect(parsed.b).toBe('clean');
      expect(parsed.a).toContain(`[credential:${type}`);
    });
  }
});

describe('maskCredentials', () => {
  it('replaces EVERY occurrence with the typed mask; the secret never survives', () => {
    const line = JSON.stringify({ a: SK, b: `text ${SK} more`, c: 'clean' });
    const out = maskCredentials(line, [{ value: SK, type: 'openai_api_key' }], KEY);
    expect(out).not.toContain(SK);
    expect(out).not.toContain(SK.slice(0, 10)); // 29/08: no clear prefix at all
    // Both occurrences gone.
    expect(out.split('[credential:openai_api_key fp:').length - 1).toBe(2);
    // Still valid JSON.
    const parsed = JSON.parse(out) as { a: string; b: string; c: string };
    expect(parsed.c).toBe('clean');
    expect(parsed.a).not.toContain(SK);
  });

  it('distinct keys → distinct fingerprints; same key twice → same fingerprint', () => {
    const line = JSON.stringify({ a: SK, b: GH, c: SK });
    const out = maskCredentials(line, [{ value: SK, type: 'openai_api_key' }, { value: GH, type: 'github_token' }], KEY);
    const parsed = JSON.parse(out) as { a: string; b: string; c: string };
    expect(parsed.a).toBe(parsed.c); // same secret → identical mask
    expect(parsed.a).not.toBe(parsed.b); // different secret → different mask
    expect(fingerprint(KEY, SK)).not.toBe(fingerprint(KEY, GH));
    expect(fingerprint(KEY, SK)).toBe(fingerprint(KEY, SK)); // deterministic
    expect(fingerprint(KEY, SK)).toHaveLength(16);
  });

  it('longest-first: a secret that is a substring of another is not corrupted', () => {
    const short = 'sk_live_1234567890abcdefghij';
    const long = `${short}KLMNOPQRST`;
    const line = JSON.stringify({ x: long, y: short });
    const out = maskCredentials(line, [{ value: short, type: 'openai_api_key' }, { value: long, type: 'openai_api_key' }], KEY);
    expect(out).not.toContain(long);
    expect(out).not.toContain(short);
    const parsed = JSON.parse(out) as { x: string; y: string };
    // The long value masked as ONE unit (its fingerprint), not short+tail.
    expect(parsed.x).toContain(fingerprint(KEY, long));
    expect(parsed.y).toContain(fingerprint(KEY, short));
  });

  it('no secrets → line unchanged', () => {
    const line = JSON.stringify({ a: 'nothing here' });
    expect(maskCredentials(line, [], KEY)).toBe(line);
  });
});

describe('loadOrCreateAuditSalt', () => {
  it('creates a 32-byte 0o600 salt lazily; second call returns the same (cached)', () => {
    const base = tempBaseDir();
    expect(existsSync(auditSaltPath(base))).toBe(false);
    const salt = loadOrCreateAuditSalt(base);
    expect(salt).toHaveLength(32);
    expect(statSync(auditSaltPath(base)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateAuditSalt(base).equals(salt)).toBe(true);
  });

  it('EEXIST race: a salt already on disk is re-read, not overwritten (convergence)', () => {
    const base = tempBaseDir();
    const preexisting = Buffer.alloc(32, 7);
    writeFileSync(auditSaltPath(base), preexisting, { mode: 0o600 });
    // Fresh process (cache reset in beforeEach): must ADOPT the existing salt.
    resetAuditKeyForTests();
    expect(loadOrCreateAuditSalt(base).equals(preexisting)).toBe(true);
  });
});

describe('resolveAuditKey', () => {
  it('returns the on-disk salt when available', () => {
    const base = tempBaseDir();
    const key = resolveAuditKey(base);
    expect(key.equals(readFileSync(auditSaltPath(base)))).toBe(true);
  });

  it('unwritable baseDir → ephemeral key, never throws, still 32 bytes', () => {
    // A baseDir whose parent is a FILE → mkdir/open fail → ephemeral fallback.
    const base = tempBaseDir();
    const asFile = join(base, 'not-a-dir');
    writeFileSync(asFile, 'x');
    resetAuditKeyForTests();
    const key = resolveAuditKey(join(asFile, 'sub'));
    expect(key).toHaveLength(32);
    // Cached: same ephemeral key within the process.
    expect(resolveAuditKey(join(asFile, 'sub')).equals(key)).toBe(true);
  });
});
