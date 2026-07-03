import { readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildManifest,
  createManifestStore,
  diffManifest,
  extractTools,
  type ToolDef,
} from '../src/detection/manifest.js';

function tool(name: string, description?: unknown, inputSchema?: unknown): ToolDef {
  return { name, description, inputSchema };
}
// A tools/list result payload from ToolDefs.
function result(...tools: ToolDef[]): unknown {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

describe('buildManifest / diffManifest (pure)', () => {
  it('order-independent: permuted tools + permuted schema keys → same hash, no diff', () => {
    const a = buildManifest([tool('a', 'da', { x: 1, y: 2 }), tool('b', 'db', { p: 1 })]);
    const b = buildManifest([tool('b', 'db', { p: 1 }), tool('a', 'da', { y: 2, x: 1 })]);
    expect(a.hash).toBe(b.hash);
    expect(diffManifest(a, b)).toBeNull();
  });

  it('no change → null', () => {
    const o = buildManifest([tool('a', 'x', { k: 1 })]);
    const n = buildManifest([tool('a', 'x', { k: 1 })]);
    expect(diffManifest(o, n)).toBeNull();
  });

  it('description change → high, description_changed', () => {
    const o = buildManifest([tool('send', 'old')]);
    const n = buildManifest([tool('send', 'new')]);
    expect(diffManifest(o, n)).toEqual({
      category: 'tool_manifest_changed',
      severity: 'high',
      findings: [{ type: 'description_changed', location: 'send' }],
    });
  });

  it('schema change → high, schema_changed', () => {
    const o = buildManifest([tool('send', 'd', { a: 1 })]);
    const n = buildManifest([tool('send', 'd', { a: 2 })]);
    expect(diffManifest(o, n)).toEqual({
      category: 'tool_manifest_changed',
      severity: 'high',
      findings: [{ type: 'schema_changed', location: 'send' }],
    });
  });

  it('add → medium, tool_added', () => {
    const o = buildManifest([tool('a', 'x')]);
    const n = buildManifest([tool('a', 'x'), tool('b', 'y')]);
    expect(diffManifest(o, n)).toEqual({
      category: 'tool_manifest_changed',
      severity: 'medium',
      findings: [{ type: 'tool_added', location: 'b' }],
    });
  });

  it('remove → medium, tool_removed', () => {
    const o = buildManifest([tool('a', 'x'), tool('b', 'y')]);
    const n = buildManifest([tool('a', 'x')]);
    expect(diffManifest(o, n)).toEqual({
      category: 'tool_manifest_changed',
      severity: 'medium',
      findings: [{ type: 'tool_removed', location: 'b' }],
    });
  });

  it('mixed add + description change → high, findings sorted by tool name', () => {
    const o = buildManifest([tool('a', 'x')]);
    const n = buildManifest([tool('a', 'x2'), tool('z', 'new')]);
    expect(diffManifest(o, n)).toEqual({
      category: 'tool_manifest_changed',
      severity: 'high',
      findings: [
        { type: 'description_changed', location: 'a' },
        { type: 'tool_added', location: 'z' },
      ],
    });
  });

  it('extractTools skips non-object / nameless entries', () => {
    const tools = extractTools({ tools: [{ name: 'ok' }, { description: 'no name' }, 42, null] });
    expect(tools.map((t) => t.name)).toEqual(['ok']);
  });
});

describe('createManifestStore', () => {
  const NOW = (): string => '2026-07-03T00:00:00.000Z';
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'xcg-manifest-'));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });
  const manifestsDir = (): string => join(baseDir, 'manifests');

  it('first session seeds silently (no detection) and writes a baseline', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    const out = store.checkAndUpdate('notion', result(tool('a', 'x')));
    expect(out.changed).toBe(false);
    expect(out.detection).toBeUndefined();
    expect(readdirSync(manifestsDir())).toHaveLength(1);
  });

  it('unchanged manifest on repeat → no detection', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    expect(store.checkAndUpdate('notion', result(tool('a', 'x'))).changed).toBe(false);
  });

  it('permuted tools between sessions → no change', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x'), tool('b', 'y')));
    expect(store.checkAndUpdate('notion', result(tool('b', 'y'), tool('a', 'x'))).changed).toBe(false);
  });

  it('description change → high detection once, then no second alert (update-once)', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('send', 'old')));
    const first = store.checkAndUpdate('notion', result(tool('send', 'new')));
    expect(first.changed).toBe(true);
    expect(first.detection?.severity).toBe('high');
    expect(first.detection?.findings).toEqual([{ type: 'description_changed', location: 'send' }]);
    // Baseline is now updated → the same manifest does not alert again.
    expect(store.checkAndUpdate('notion', result(tool('send', 'new'))).changed).toBe(false);
  });

  it('add then remove → medium detections', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    const added = store.checkAndUpdate('notion', result(tool('a', 'x'), tool('b', 'y')));
    expect(added.detection?.severity).toBe('medium');
    expect(added.detection?.findings).toEqual([{ type: 'tool_added', location: 'b' }]);
    const removed = store.checkAndUpdate('notion', result(tool('a', 'x')));
    expect(removed.detection?.severity).toBe('medium');
    expect(removed.detection?.findings).toEqual([{ type: 'tool_removed', location: 'b' }]);
  });

  it('corrupt baseline → silent reseed (no detection), then valid again', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    const file = join(manifestsDir(), readdirSync(manifestsDir())[0]!);
    writeFileSync(file, '{ not valid json');
    const reseed = store.checkAndUpdate('notion', result(tool('a', 'DIFFERENT')));
    expect(reseed.changed).toBe(false);
    // Baseline is valid again → a further real change alerts.
    expect(store.checkAndUpdate('notion', result(tool('a', 'CHANGED-AGAIN'))).changed).toBe(true);
  });

  it('unknown version → silent reseed', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    const file = join(manifestsDir(), readdirSync(manifestsDir())[0]!);
    writeFileSync(file, JSON.stringify({ v: 99, mcp: 'notion', hash: 'x', tools: {} }));
    expect(store.checkAndUpdate('notion', result(tool('a', 'y'))).changed).toBe(false);
  });

  it('cold-start seed uses a plain write (no .bak); a later change writes atomically', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    expect(readdirSync(manifestsDir()).some((f) => f.endsWith('.bak'))).toBe(false);
    store.checkAndUpdate('notion', result(tool('a', 'y'))); // change → writeAtomic
    expect(readdirSync(manifestsDir()).some((f) => f.endsWith('.bak'))).toBe(true);
  });

  it('concurrent wrappers converge without a spurious detection', () => {
    const a = createManifestStore(baseDir, { now: NOW });
    const b = createManifestStore(baseDir, { now: NOW });
    a.checkAndUpdate('notion', result(tool('a', 'x'))); // A seeds
    expect(b.checkAndUpdate('notion', result(tool('a', 'x'))).changed).toBe(false); // B sees the seed
  });

  it('separate connectors use separate files', () => {
    const store = createManifestStore(baseDir, { now: NOW });
    store.checkAndUpdate('notion', result(tool('a', 'x')));
    store.checkAndUpdate('linear', result(tool('a', 'x')));
    expect(readdirSync(manifestsDir())).toHaveLength(2);
  });
});
