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

describe('maskCredentials', () => {
  it('replaces EVERY occurrence with prefix + fingerprint; the secret never survives', () => {
    const line = JSON.stringify({ a: SK, b: `text ${SK} more`, c: 'clean' });
    const out = maskCredentials(line, [SK], KEY);
    expect(out).not.toContain(SK);
    expect(out).toContain(`${SK.slice(0, 10)}…[fp:`);
    // Both occurrences gone.
    expect(out.split(SK.slice(0, 10)).length - 1).toBe(2);
    // Still valid JSON.
    const parsed = JSON.parse(out) as { a: string; b: string; c: string };
    expect(parsed.c).toBe('clean');
    expect(parsed.a).not.toContain(SK);
  });

  it('distinct keys → distinct fingerprints; same key twice → same fingerprint', () => {
    const line = JSON.stringify({ a: SK, b: GH, c: SK });
    const out = maskCredentials(line, [SK, GH], KEY);
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
    const out = maskCredentials(line, [short, long], KEY);
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
