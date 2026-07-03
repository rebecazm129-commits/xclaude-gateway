import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RETENTION_CONFIG,
  decodeUlidTime,
  estimatePurgable,
  estimatePurgableForMode,
  isPurgeMode,
  isSessionFile,
  readLastPurgeMarker,
  readRetentionConfig,
  runSweep,
  writeRetentionConfig,
} from '../src/main/retention.js';
import type { RetentionConfig } from '../src/shared/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Reference ULIDs with known embedded timestamps (verified against ulid's
// decodeTime). OLDER is the canonical example from the ULID spec.
const OLD_ULID = '01KRDWJ6Y9SYW2KQRTRZSX6ERT';
const OLD_MS = 1778582625225; // 2026-05-12T10:43:45.225Z
const OLDER_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OLDER_MS = 1508808576371; // 2017-10-24T01:29:36.371Z

function cfg(purgeMode: RetentionConfig['purgeMode']): RetentionConfig {
  return { purgeMode, sizeWarnBytes: 524_288_000 };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xcg-retention-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Writes a session/audit file and (optionally) pins its mtime.
async function writeFileWithMtime(name: string, mtimeMs?: number): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, '{"v":1}\n');
  if (mtimeMs !== undefined) {
    await utimes(p, new Date(mtimeMs), new Date(mtimeMs));
  }
  return p;
}

describe('decodeUlidTime', () => {
  it('decodes the 48-bit timestamp of a valid ULID', () => {
    expect(decodeUlidTime(OLD_ULID)).toBe(OLD_MS);
    expect(decodeUlidTime(OLDER_ULID)).toBe(OLDER_MS);
  });

  it('is case-insensitive (ulid() emits uppercase, but decode either)', () => {
    expect(decodeUlidTime(OLD_ULID.toLowerCase())).toBe(OLD_MS);
  });

  it('returns null for a non-ULID string (wrong length)', () => {
    expect(decodeUlidTime('plain-name')).toBeNull();
    expect(decodeUlidTime('')).toBeNull();
  });

  it('returns null for a 26-char string with a non-Crockford char (I/L/O/U)', () => {
    expect(decodeUlidTime('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBeNull();
  });
});

describe('isPurgeMode', () => {
  it('accepts exactly the four valid modes', () => {
    expect(isPurgeMode('never')).toBe(true);
    expect(isPurgeMode('30d')).toBe(true);
    expect(isPurgeMode('90d')).toBe(true);
    expect(isPurgeMode('365d')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPurgeMode('7d')).toBe(false);
    expect(isPurgeMode('NEVER')).toBe(false);
    expect(isPurgeMode(null)).toBe(false);
    expect(isPurgeMode(undefined)).toBe(false);
    expect(isPurgeMode(30)).toBe(false);
  });
});

describe('isSessionFile', () => {
  it('matches *.jsonl except app-events.jsonl', () => {
    expect(isSessionFile(`${OLD_ULID}.jsonl`)).toBe(true);
    expect(isSessionFile('app-events.jsonl')).toBe(false);
    expect(isSessionFile('foo.txt')).toBe(false);
  });
});

describe('runSweep — age = now - max(decodeTime, mtime)', () => {
  it('keeps a file whose ULID is old but whose mtime is recent', async () => {
    const now = OLD_MS + 100 * DAY_MS;
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, now - DAY_MS); // recent mtime
    const emit = vi.fn();
    const outcome = await runSweep(dir, cfg('30d'), now, emit);
    expect(existsSync(join(dir, `${OLD_ULID}.jsonl`))).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(outcome.purged).toBeNull();
  });

  it('purges a file old by both ULID time and mtime', async () => {
    const now = OLD_MS + 100 * DAY_MS;
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS); // old mtime too
    const emit = vi.fn();
    const outcome = await runSweep(dir, cfg('30d'), now, emit);
    expect(existsSync(join(dir, `${OLD_ULID}.jsonl`))).toBe(false);
    expect(outcome.purged?.filesPurged).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('runSweep — fail-safe & exemption', () => {
  it('never purges non-ULID names or app-events.jsonl, even when ancient', async () => {
    const now = OLD_MS + 1000 * DAY_MS;
    await writeFileWithMtime('app-events.jsonl', OLDER_MS); // exempt
    await writeFileWithMtime('plain-name.jsonl', OLDER_MS); // non-ULID (short)
    await writeFileWithMtime('IIIIIIIIIIIIIIIIIIIIIIIIII.jsonl', OLDER_MS); // 26 chars, invalid
    const emit = vi.fn();
    await runSweep(dir, cfg('30d'), now, emit);
    expect(existsSync(join(dir, 'app-events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'plain-name.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'IIIIIIIIIIIIIIIIIIIIIIIIII.jsonl'))).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('runSweep — aggregated event', () => {
  it('emits ONE marker with the count and ULID time range for a multi-file purge', async () => {
    const now = OLD_MS + 100 * DAY_MS;
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    await writeFileWithMtime(`${OLDER_ULID}.jsonl`, OLDER_MS);
    const emit = vi.fn();
    const outcome = await runSweep(dir, cfg('30d'), now, emit);
    expect(existsSync(join(dir, `${OLD_ULID}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `${OLDER_ULID}.jsonl`))).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toEqual({
      filesPurged: 2,
      purgedFromTs: new Date(OLDER_MS).toISOString(), // oldest
      purgedUntilTs: new Date(OLD_MS).toISOString(), // newest
      purgeMode: '30d',
    });
    expect(outcome.purged).toEqual({
      filesPurged: 2,
      purgedFromTs: new Date(OLDER_MS).toISOString(),
      purgedUntilTs: new Date(OLD_MS).toISOString(),
    });
  });
});

describe('runSweep — mode never', () => {
  it('deletes nothing and emits nothing, but still computes size', async () => {
    const now = OLD_MS + 1000 * DAY_MS;
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    const emit = vi.fn();
    const outcome = await runSweep(dir, cfg('never'), now, emit);
    expect(existsSync(join(dir, `${OLD_ULID}.jsonl`))).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(outcome.purged).toBeNull();
    expect(outcome.size.fileCount).toBe(1);
    expect(outcome.size.totalBytes).toBeGreaterThan(0);
  });
});

describe('estimatePurgable', () => {
  it('counts by decodeTime ONLY — ignores mtime (unlike the sweep)', async () => {
    const now = OLD_MS + 100 * DAY_MS;
    // Recent mtime: the real sweep would NOT purge this, but the estimate
    // (decodeTime only) still counts it. This is the intended divergence.
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, now - DAY_MS);
    expect(await estimatePurgable(dir, '30d', now)).toBe(1);
  });

  it('returns 0 for mode never', async () => {
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    expect(await estimatePurgable(dir, 'never', OLD_MS + 1000 * DAY_MS)).toBe(0);
  });

  it('excludes app-events.jsonl and non-ULID names', async () => {
    const now = OLD_MS + 1000 * DAY_MS;
    await writeFileWithMtime('app-events.jsonl', OLDER_MS);
    await writeFileWithMtime('plain-name.jsonl', OLDER_MS);
    expect(await estimatePurgable(dir, '30d', now)).toBe(0);
  });
});

describe('estimatePurgableForMode (retention:estimate pure piece)', () => {
  it('returns 0 for an invalid / non-enum mode (no throw)', async () => {
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    expect(await estimatePurgableForMode(dir, '7d', OLD_MS + 100 * DAY_MS)).toBe(0);
    expect(await estimatePurgableForMode(dir, null, OLD_MS + 100 * DAY_MS)).toBe(0);
    expect(await estimatePurgableForMode(dir, 42, OLD_MS + 100 * DAY_MS)).toBe(0);
  });

  it('returns 0 for never', async () => {
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    expect(await estimatePurgableForMode(dir, 'never', OLD_MS + 1000 * DAY_MS)).toBe(0);
  });

  it('counts purgable sessions (by decodeTime) for a valid mode', async () => {
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    await writeFileWithMtime(`${OLDER_ULID}.jsonl`, OLDER_MS);
    expect(await estimatePurgableForMode(dir, '30d', OLD_MS + 100 * DAY_MS)).toBe(2);
  });
});

describe('settings.json config store', () => {
  it('round-trips through writeRetentionConfig (cold-start seed + writeAtomic)', async () => {
    const wr = writeRetentionConfig({ purgeMode: '90d', sizeWarnBytes: 12345 }, dir);
    expect(wr.ok).toBe(true);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(await readRetentionConfig(dir)).toEqual({
      purgeMode: '90d',
      sizeWarnBytes: 12345,
    });
  });

  it('returns defaults when settings.json is missing', async () => {
    expect(await readRetentionConfig(join(dir, 'does-not-exist'))).toEqual(
      DEFAULT_RETENTION_CONFIG,
    );
  });

  it('falls back to defaults for invalid mode / size in the file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ v: 1, retention: { purgeMode: '7d', sizeWarnBytes: -1 } }),
    );
    expect(await readRetentionConfig(dir)).toEqual(DEFAULT_RETENTION_CONFIG);
  });
});

describe('readLastPurgeMarker (default emit → app-events.jsonl)', () => {
  it('reads back the aggregated marker written by the real sweep', async () => {
    const now = OLD_MS + 100 * DAY_MS;
    await writeFileWithMtime(`${OLD_ULID}.jsonl`, OLD_MS);
    await writeFileWithMtime(`${OLDER_ULID}.jsonl`, OLDER_MS);
    // Default emit (no mock) writes app.retention_purged to app-events.jsonl.
    await runSweep(dir, cfg('30d'), now);
    const marker = await readLastPurgeMarker(dir);
    expect(marker).not.toBeNull();
    expect(marker!.filesPurged).toBe(2);
    expect(marker!.purgeMode).toBe('30d');
    expect(marker!.purgedUntilTs).toBe(new Date(OLD_MS).toISOString());
    expect(typeof marker!.ts).toBe('string');
    // app-events.jsonl itself is never purged.
    expect(existsSync(join(dir, 'app-events.jsonl'))).toBe(true);
  });

  it('returns null when app-events.jsonl does not exist', async () => {
    expect(await readLastPurgeMarker(dir)).toBeNull();
  });
});
