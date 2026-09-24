// Observing sections and maintaining the v2 baseline for each.

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildManifest } from '../src/detection/manifest.js';
import {
  SECTION_SOURCE,
  observeSection,
  sectionForMethod,
  snapshotOf,
  type ObserveDeps,
} from '../src/detection/manifest-sections.js';
import { readBaselineV2, v2PathFor, emptyBaseline } from '../src/detection/manifest-v2.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-sections-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const NOW = '2026-09-24T12:00:00.000Z';
let n = 0;
const deps = (over: Partial<ObserveDeps> = {}): ObserveDeps => {
  const baseDir = join(tmpDir, `case-${(n += 1)}`);
  mkdirSync(baseDir, { recursive: true });
  return { baseDir, appVersion: '1.0.0', now: () => NOW, ...over };
};
const kinds = (o: { events: { event: string }[] }): string[] => o.events.map((e) => e.event);

describe('section routing', () => {
  it('maps every method to its section, and discovery is not a tool source', () => {
    expect(sectionForMethod('tools/list')).toBe('tools');
    expect(sectionForMethod('resources/list')).toBe('resources');
    expect(sectionForMethod('resources/templates/list')).toBe('resource_templates');
    expect(sectionForMethod('prompts/list')).toBe('prompts');
    expect(sectionForMethod('server/discover')).toBe('discovery');
    expect(sectionForMethod('tools/call')).toBeNull();
    // server/discover returns supportedVersions / capabilities / instructions,
    // never a tool list.
    expect(SECTION_SOURCE.discovery.key).toBeNull();
  });

  it('snapshotOf returns null when the result does not carry the collection', () => {
    expect(snapshotOf('tools', { resources: [] })).toBeNull();
    expect(snapshotOf('resources', null)).toBeNull();
    expect(snapshotOf('prompts', { prompts: 'not an array' })).toBeNull();
  });

  it('snapshotOf canonicalizes the collection, so item order is irrelevant', () => {
    const a = snapshotOf('tools', { tools: [{ name: 'b' }, { name: 'a' }] });
    const b = snapshotOf('tools', { tools: [{ name: 'a' }, { name: 'b' }] });
    expect(a).toEqual(b);
  });
});

describe('observeSection — first sight', () => {
  it('seeds and emits section_initialized, with no detection', () => {
    const d = deps();
    const out = observeSection(d, 'notion', 'resources', { resources: [{ uri: 'file:///a' }] });
    expect(kinds(out)).toEqual(['section_initialized']);
    expect(out.detection).toBeUndefined();
    const read = readBaselineV2(d.baseDir, 'notion');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.baseline.sections.resources?.state).toBe('current');
  });

  it('each section initializes independently', () => {
    const d = deps();
    observeSection(d, 'notion', 'tools', { tools: [{ name: 't' }] });
    const out = observeSection(d, 'notion', 'prompts', { prompts: [{ name: 'p' }] });
    expect(kinds(out)).toEqual(['section_initialized']);
    const read = readBaselineV2(d.baseDir, 'notion');
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(read.baseline.sections).sort()).toEqual(['prompts', 'tools']);
  });

  it('a malformed result leaves the baseline untouched and says nothing', () => {
    const d = deps();
    const out = observeSection(d, 'notion', 'tools', { nope: true });
    expect(out.events).toEqual([]);
    expect(readBaselineV2(d.baseDir, 'notion').kind).toBe('absent');
  });

  it('discovery stores instructions and capabilities', () => {
    const d = deps();
    observeSection(d, 'notion', 'discovery', {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      instructions: 'Call me first.',
    });
    const read = readBaselineV2(d.baseDir, 'notion');
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.baseline.sections.discovery?.snapshot).toMatchObject({
      instructions: 'Call me first.',
    });
  });
});

describe('observeSection — steady state', () => {
  it('an unchanged section emits nothing', () => {
    const d = deps();
    const res = { tools: [{ name: 't', description: 'x' }] };
    observeSection(d, 'notion', 'tools', res);
    expect(observeSection(d, 'notion', 'tools', res).events).toEqual([]);
  });

  it('a reshuffled collection is NOT a change', () => {
    const d = deps();
    observeSection(d, 'notion', 'tools', { tools: [{ name: 'a' }, { name: 'b' }] });
    const out = observeSection(d, 'notion', 'tools', { tools: [{ name: 'b' }, { name: 'a' }] });
    expect(out.events).toEqual([]);
  });

  it('a wire change advances the baseline and records the previous hash', () => {
    const d = deps();
    observeSection(d, 'notion', 'resources', { resources: [{ uri: 'file:///a' }] });
    const before = readBaselineV2(d.baseDir, 'notion');
    if (before.kind !== 'ok') throw new Error('expected ok');
    const firstHash = before.baseline.sections.resources!.wire_hash;
    observeSection(d, 'notion', 'resources', { resources: [{ uri: 'https://elsewhere/a' }] });
    const after = readBaselineV2(d.baseDir, 'notion');
    if (after.kind !== 'ok') throw new Error('expected ok');
    const s = after.baseline.sections.resources!;
    expect(s.wire_hash).not.toBe(firstHash);
    expect(s.recent_wire_hashes).toContain(firstHash);
  });
});

describe('observeSection — migration', () => {
  const v1Tool = { name: 'send', description: 'Send.', inputSchema: { type: 'object', properties: { body: {} } } };

  it('tools with an unchanged v1 baseline → migrated, no detection', () => {
    const d = deps({ readV1: () => buildManifest([v1Tool]) });
    const out = observeSection(d, 'notion', 'tools', { tools: [v1Tool] });
    expect(kinds(out)).toEqual(['migrated', 'section_initialized']);
    expect(out.detection).toBeUndefined();
    expect(out.events[0]!.coverageExpanded).toContain('section:prompts');
  });

  it('tools with a CHANGED v1 baseline → detection AND migration', () => {
    // The correction: a real change in what v1 already watched is reported,
    // not swallowed by the housekeeping step.
    const d = deps({ readV1: () => buildManifest([v1Tool]) });
    const changed = { ...v1Tool, inputSchema: { type: 'object', properties: { body: {}, bcc_emails: {} } } };
    const out = observeSection(d, 'notion', 'tools', { tools: [changed] });
    expect(out.detection?.category).toBe('tool_manifest_changed');
    expect(out.detection?.severity).toBe('high');
    expect(kinds(out)).toEqual(['migrated', 'section_initialized']);
  });

  it('only `tools` migrates — the other sections never had a v1 baseline', () => {
    const d = deps({ readV1: () => buildManifest([v1Tool]) });
    const out = observeSection(d, 'notion', 'prompts', { prompts: [{ name: 'p' }] });
    expect(kinds(out)).toEqual(['section_initialized']);
  });
});

describe('observeSection — integrity', () => {
  it('a corrupt file is reported and reseeded, never as a manifest change', () => {
    const d = deps();
    mkdirSync(join(d.baseDir, 'manifests', 'v2'), { recursive: true });
    writeFileSync(v2PathFor(d.baseDir, 'notion'), '{ broken', { mode: 0o600 });
    const out = observeSection(d, 'notion', 'tools', { tools: [{ name: 't' }] });
    expect(kinds(out)).toEqual(['reseeded', 'section_initialized']);
    expect(out.events[0]!.reason).toBe('corrupt');
    expect(out.detection).toBeUndefined();
  });

  it('a malformed SECTION is reported as an integrity warning and reseeded', () => {
    const d = deps();
    mkdirSync(join(d.baseDir, 'manifests', 'v2'), { recursive: true });
    writeFileSync(
      v2PathFor(d.baseDir, 'notion'),
      JSON.stringify({ ...emptyBaseline('notion', '1.0.0', NOW), sections: { tools: { junk: 1 } } }),
      { mode: 0o600 },
    );
    const out = observeSection(d, 'notion', 'tools', { tools: [{ name: 't' }] });
    expect(kinds(out)).toEqual(['reseeded', 'section_initialized']);
    expect(out.events[0]!.section).toBe('tools');
  });

  it('a file from a NEWER build is left entirely alone', () => {
    const d = deps();
    mkdirSync(join(d.baseDir, 'manifests', 'v2'), { recursive: true });
    const path = v2PathFor(d.baseDir, 'notion');
    const content = JSON.stringify({ ...emptyBaseline('notion', '9', NOW), storage_version: 99 });
    writeFileSync(path, content, { mode: 0o600 });
    const out = observeSection(d, 'notion', 'tools', { tools: [{ name: 't' }] });
    expect(out.events).toEqual([]);
    expect(readBaselineV2(d.baseDir, 'notion').kind).toBe('future');
  });

  it('a stale projection version is recomputed from the SNAPSHOT and announced', () => {
    const d = deps();
    observeSection(d, 'notion', 'tools', { tools: [{ name: 't', description: 'x' }] });
    // Simulate a file written by a build with an older projection.
    const read = readBaselineV2(d.baseDir, 'notion');
    if (read.kind !== 'ok') throw new Error('expected ok');
    const stale = { ...read.baseline, security_projection_version: 0 };
    writeFileSync(v2PathFor(d.baseDir, 'notion'), JSON.stringify(stale), { mode: 0o600 });
    const out = observeSection(d, 'notion', 'tools', { tools: [{ name: 't', description: 'x' }] });
    expect(kinds(out)).toContain('projection_migrated');
    // Our rules changed, not theirs: no detection.
    expect(out.detection).toBeUndefined();
    expect(out.events.find((e) => e.event === 'projection_migrated')?.fromVersion).toBe(0);
  });
});
