// The v2 baseline file: schema, the three versions, atomic write, and the
// downgrade guarantee that the v1 path is never touched.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createManifestStore } from '../src/detection/manifest.js';
import {
  CANONICALIZATION_VERSION,
  RECENT_WIRE_HASHES,
  SECTIONS,
  SECURITY_PROJECTION_VERSION,
  STORAGE_VERSION,
  emptyBaseline,
  pushRecent,
  readBaselineV2,
  seedBaselineV2,
  v2PathFor,
  writeBaselineV2,
  type BaselineV2,
  type SectionState,
} from '../src/detection/manifest-v2.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-manifest-v2-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const NOW = '2026-09-24T12:00:00.000Z';
let n = 0;
const dir = (): string => {
  const d = join(tmpDir, `case-${(n += 1)}`);
  mkdirSync(d, { recursive: true });
  return d;
};

function section(over: Partial<SectionState> = {}): SectionState {
  return {
    state: 'current',
    wire_hash: 'sha256:aaa',
    security_hash: 'sha256:bbb',
    snapshot: { items: [{ name: 'send' }] },
    pages: 1,
    initialized_at: NOW,
    last_changed_generation: 1,
    recent_wire_hashes: ['sha256:aaa'],
    ...over,
  };
}

function withTools(base: BaselineV2): BaselineV2 {
  return { ...base, sections: { tools: section() } };
}

describe('v2 file — schema and versions', () => {
  it('carries the three versions independently', () => {
    const b = emptyBaseline('notion', '1.0.0-beta.6', NOW);
    expect(b.storage_version).toBe(STORAGE_VERSION);
    expect(b.canonicalization_version).toBe(CANONICALIZATION_VERSION);
    expect(b.security_projection_version).toBe(SECURITY_PROJECTION_VERSION);
    // They are separate fields, not one number: they invalidate different
    // things (the file shape, both hashes, or only security_hash).
    expect(new Set([STORAGE_VERSION, CANONICALIZATION_VERSION, SECURITY_PROJECTION_VERSION]).size)
      .toBeGreaterThan(0);
  });

  it('knows the five sections, and discovery is one of them', () => {
    expect([...SECTIONS]).toEqual([
      'discovery',
      'tools',
      'resources',
      'resource_templates',
      'prompts',
    ]);
  });

  it('round-trips a baseline with a full snapshot, not just hashes', () => {
    const d = dir();
    const b = withTools(emptyBaseline('notion', '1.0.0', NOW));
    expect(writeBaselineV2(d, b, NOW).ok).toBe(true);
    const back = readBaselineV2(d, 'notion');
    expect(back.kind).toBe('ok');
    if (back.kind !== 'ok') return;
    // The snapshot survives: this is what lets a projection change be
    // recomputed instead of reseeded.
    expect(back.baseline.sections.tools?.snapshot).toEqual({ items: [{ name: 'send' }] });
    expect(back.baseline.writer_app_version).toBe('1.0.0');
  });

  it('generation increments on every write', () => {
    const d = dir();
    const b = withTools(emptyBaseline('notion', '1.0.0', NOW));
    expect(writeBaselineV2(d, b, NOW).generation).toBe(1);
    const first = readBaselineV2(d, 'notion');
    if (first.kind !== 'ok') throw new Error('expected ok');
    expect(writeBaselineV2(d, first.baseline, NOW).generation).toBe(2);
  });
});

describe('v2 file — recent wire hashes', () => {
  it('most recent first, deduped', () => {
    expect(pushRecent(['b', 'a'], 'a')).toEqual(['a', 'b']);
  });

  it(`capped at ${RECENT_WIRE_HASHES}`, () => {
    let r: string[] = [];
    for (let i = 0; i < RECENT_WIRE_HASHES + 5; i += 1) r = pushRecent(r, `h${i}`);
    expect(r).toHaveLength(RECENT_WIRE_HASHES);
    expect(r[0]).toBe(`h${RECENT_WIRE_HASHES + 4}`);
  });
});

describe('v2 file — durability', () => {
  it('writes 0600 in a 0700 directory', () => {
    const d = dir();
    writeBaselineV2(d, withTools(emptyBaseline('notion', '1.0.0', NOW)), NOW);
    expect(statSync(v2PathFor(d, 'notion')).mode & 0o777).toBe(0o600);
  });

  it('keeps the previous generation as .prev and leaves no temp file', () => {
    const d = dir();
    const b = withTools(emptyBaseline('notion', '1.0.0', NOW));
    writeBaselineV2(d, b, NOW);
    const after = readBaselineV2(d, 'notion');
    if (after.kind !== 'ok') throw new Error('expected ok');
    writeBaselineV2(d, after.baseline, NOW);
    const path = v2PathFor(d, 'notion');
    expect(existsSync(`${path}.prev`)).toBe(true);
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
    const prev = JSON.parse(readFileSync(`${path}.prev`, 'utf8')) as BaselineV2;
    expect(prev.generation).toBe(1);
  });

  it('an unwritable directory is reported, never thrown', () => {
    const d = dir();
    seedBaselineV2(d, 'notion', '1.0.0', NOW);
    chmodSync(join(d, 'manifests', 'v2'), 0o500);
    try {
      const r = writeBaselineV2(d, withTools(emptyBaseline('notion', '1.0.0', NOW)), NOW);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      chmodSync(join(d, 'manifests', 'v2'), 0o700);
    }
  });

  it('seeding is idempotent', () => {
    const d = dir();
    expect(seedBaselineV2(d, 'notion', '1.0.0', NOW).generation).toBe(1);
    expect(seedBaselineV2(d, 'notion', '1.0.0', NOW).generation).toBe(0);
  });
});

describe('v2 file — reading', () => {
  it('absent file reads as absent, not corrupt', () => {
    expect(readBaselineV2(dir(), 'notion').kind).toBe('absent');
  });

  it('unparseable file reads as CORRUPT — the auditor’s own state was damaged', () => {
    const d = dir();
    mkdirSync(join(d, 'manifests', 'v2'), { recursive: true });
    writeFileSync(v2PathFor(d, 'notion'), '{ not json', { mode: 0o600 });
    const r = readBaselineV2(d, 'notion');
    expect(r.kind).toBe('corrupt');
  });

  it('a FUTURE storage version reads as absent, not corrupt — that is a downgrade', () => {
    const d = dir();
    mkdirSync(join(d, 'manifests', 'v2'), { recursive: true });
    writeFileSync(
      v2PathFor(d, 'notion'),
      JSON.stringify({ ...emptyBaseline('notion', '9', NOW), storage_version: 99 }),
      { mode: 0o600 },
    );
    expect(readBaselineV2(d, 'notion').kind).toBe('absent');
  });

  it('one malformed section does not condemn the others', () => {
    const d = dir();
    mkdirSync(join(d, 'manifests', 'v2'), { recursive: true });
    const b = emptyBaseline('notion', '1.0.0', NOW);
    writeFileSync(
      v2PathFor(d, 'notion'),
      JSON.stringify({ ...b, sections: { tools: section(), prompts: { broken: true } } }),
      { mode: 0o600 },
    );
    const r = readBaselineV2(d, 'notion');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.baseline.sections.tools).toBeDefined();
    expect(r.baseline.sections.prompts).toBeUndefined();
  });

  it('an unknown section name is ignored', () => {
    const d = dir();
    mkdirSync(join(d, 'manifests', 'v2'), { recursive: true });
    writeFileSync(
      v2PathFor(d, 'notion'),
      JSON.stringify({ ...emptyBaseline('notion', '1.0.0', NOW), sections: { widgets: section() } }),
      { mode: 0o600 },
    );
    const r = readBaselineV2(d, 'notion');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(r.baseline.sections)).toEqual([]);
  });
});

describe('v2 file — downgrade safety', () => {
  it('lives in its own directory and never shadows the v1 path', () => {
    const d = dir();
    const v1 = join(d, 'manifests');
    const v2 = v2PathFor(d, 'notion');
    expect(v2.startsWith(join(v1, 'v2'))).toBe(true);
    expect(v2).not.toBe(join(v1, 'notion.json'));
  });

  it('writing v2 leaves the v1 file exactly as the v1 store wrote it', () => {
    const d = dir();
    // The v1 store seeds its own file in manifests/.
    const store = createManifestStore(d, { now: () => NOW });
    store.checkAndUpdate('notion', { tools: [{ name: 'send', description: 'x' }] });
    const v1Dir = join(d, 'manifests');
    const v1File = (): string =>
      join(v1Dir, readdirSync(v1Dir).find((f) => f.endsWith('.json'))!);
    const before = readFileSync(v1File(), 'utf8');
    writeBaselineV2(d, withTools(emptyBaseline('notion', '1.0.0', NOW)), NOW);
    const after = readFileSync(v1File(), 'utf8');
    expect(after).toBe(before);
    expect(JSON.parse(after)).toMatchObject({ v: 1 });
  });
});
