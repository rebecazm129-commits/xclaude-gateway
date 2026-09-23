import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RELOGIN_STATE_FILENAME,
  readNotified,
  reloginStatePath,
  writeNotified,
} from '../../src/main/relogin-state.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-relogin-state-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function dir(name: string): string {
  const d = join(tmpDir, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('relogin-state', () => {
  it('absent file → empty map (= the next pass notifies)', () => {
    expect(readNotified(dir('absent')).size).toBe(0);
  });

  it('round-trips a map', () => {
    const d = dir('roundtrip');
    writeNotified(new Map([['stripe', '2026-09-08T05:08:12.557Z']]), d);
    const back = readNotified(d);
    expect(back.get('stripe')).toBe('2026-09-08T05:08:12.557Z');
  });

  it('writes 0o600 and lives in its OWN file, not settings.json', () => {
    const d = dir('perms');
    writeNotified(new Map([['notion', 'T']]), d);
    const path = reloginStatePath(d);
    expect(path.endsWith(RELOGIN_STATE_FILENAME)).toBe(true);
    expect(path).not.toContain('settings.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a second write updates in place (atomic path, no .bak litter)', () => {
    const d = dir('rewrite');
    writeNotified(new Map([['stripe', 'A']]), d);
    writeNotified(new Map([['stripe', 'B']]), d);
    expect(readNotified(d).get('stripe')).toBe('B');
    expect(() => statSync(`${reloginStatePath(d)}.bak`)).toThrow();
  });

  it('corrupt JSON → empty map, no throw', () => {
    const d = dir('corrupt');
    writeFileSync(reloginStatePath(d), '{ not json', { mode: 0o600 });
    expect(() => readNotified(d)).not.toThrow();
    expect(readNotified(d).size).toBe(0);
  });

  it('valid JSON of the wrong shape → empty map, no throw', () => {
    const d = dir('shape');
    writeFileSync(reloginStatePath(d), JSON.stringify({ v: 1, notified: [1, 2] }), { mode: 0o600 });
    expect(readNotified(d).size).toBe(0);
  });

  it('drops non-string entries but keeps the valid ones', () => {
    const d = dir('mixed');
    writeFileSync(
      reloginStatePath(d),
      JSON.stringify({ v: 1, notified: { stripe: 'T', notion: 42, slack: '' } }),
      { mode: 0o600 },
    );
    const m = readNotified(d);
    expect([...m.entries()]).toEqual([['stripe', 'T']]);
  });

  it('an unwritable directory is swallowed, never thrown', () => {
    const d = dir('readonly');
    chmodSync(d, 0o500);
    try {
      expect(() => writeNotified(new Map([['stripe', 'T']]), d)).not.toThrow();
    } finally {
      chmodSync(d, 0o700);
    }
  });

  it('is stored sorted, so the file is stable between runs', () => {
    const d = dir('sorted');
    writeNotified(
      new Map([
        ['slack', 'T'],
        ['apollo', 'T'],
        ['notion', 'T'],
      ]),
      d,
    );
    const parsed = JSON.parse(readFileSync(reloginStatePath(d), 'utf8')) as {
      notified: Record<string, string>;
    };
    expect(Object.keys(parsed.notified)).toEqual(['apollo', 'notion', 'slack']);
  });
});
