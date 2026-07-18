// Classification entry × gating against the REAL spike 3 captures: the
// approve-all / reject-all / no-decision states come from the fixture files,
// not hand-built objects (see fixtures/config-cc/README.md for provenance).

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyEntries } from '../../src/config-cc/classify.js';
import { readMcpJson, readSettingsLocal } from '../../src/config-cc/parser.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';
import type { CcClassifiedEntry, CcServerEntry } from '../../src/config-cc/types.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));

describe('classifyEntries × spike 3 fixtures (F2.1a)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Installs the paso4 .mcp.json (toy-stdio + toy-http) plus an optional
  // settings fixture, then runs the full read → classify pipeline exactly as
  // a consumer would: scopes → parser → classify.
  function classifyProject(settingsFixture?: string): readonly CcClassifiedEntry[] {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), files.entriesPath);
    if (settingsFixture !== undefined && files.gatingPath !== undefined) {
      mkdirSync(dirname(files.gatingPath), { recursive: true });
      copyFileSync(join(FIXTURE_DIR, settingsFixture), files.gatingPath);
    }
    const mcp = readMcpJson(files.entriesPath);
    expect(mcp.ok).toBe(true);
    if (!mcp.ok) throw new Error('unreachable');
    if (files.gatingPath === undefined) throw new Error('unreachable');
    const gating = readSettingsLocal(files.gatingPath);
    expect(gating.ok).toBe(true);
    if (!gating.ok) throw new Error('unreachable');
    return classifyEntries(mcp.servers, gating);
  }

  function statusOf(entries: readonly CcClassifiedEntry[], name: string): CcClassifiedEntry {
    const e = entries.find((x) => x.name === name);
    if (e === undefined) throw new Error(`no entry ${name}`);
    return e;
  }

  it('approve-all (paso6): stdio → enabled; http → unsupported even though listed as enabled', () => {
    const entries = classifyProject('settings.local.json.paso6');
    expect(statusOf(entries, 'toy-stdio').status).toBe('enabled');
    // paso6 lists toy-http in enabledMcpjsonServers, but unsupported wins:
    // user approval does not make an http entry actionable by the gateway.
    expect(statusOf(entries, 'toy-http')).toMatchObject({ status: 'unsupported', reason: 'type-http' });
  });

  it('reject-all (pasoB): stdio → disabled; http → unsupported', () => {
    const entries = classifyProject('settings.local.json.pasoB-rechazo');
    expect(statusOf(entries, 'toy-stdio').status).toBe('disabled');
    expect(statusOf(entries, 'toy-http')).toMatchObject({ status: 'unsupported', reason: 'type-http' });
  });

  it('no settings file (no decision yet): stdio → pending; http → unsupported', () => {
    const entries = classifyProject(undefined);
    expect(statusOf(entries, 'toy-stdio').status).toBe('pending');
    expect(statusOf(entries, 'toy-http')).toMatchObject({ status: 'unsupported', reason: 'type-http' });
  });

  it('absent .mcp.json: zero entries to classify', () => {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    const mcp = readMcpJson(files.entriesPath);
    expect(mcp.ok).toBe(true);
    if (!mcp.ok) return;
    expect(classifyEntries(mcp.servers, { enabled: [], disabled: [] })).toEqual([]);
  });

  it('carries the entry through: enabled toy-stdio keeps its parsed fields', () => {
    const entries = classifyProject('settings.local.json.paso6');
    const e = statusOf(entries, 'toy-stdio');
    expect(e.entry).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['/Users/user/spikes/xcg-spike3/toy-server.js'],
      env: {},
    });
  });
});

describe('classifyEntries — defensive precedences (hand-built shapes)', () => {
  function entry(fields: Omit<CcServerEntry, 'raw'>): CcServerEntry {
    return { ...fields, raw: { ...fields } };
  }

  it('a name listed in BOTH gating lists classifies disabled (fail safe)', () => {
    const r = classifyEntries(
      { s: entry({ type: 'stdio', command: 'node' }) },
      { enabled: ['s'], disabled: ['s'] },
    );
    expect(r[0]).toMatchObject({ status: 'disabled', name: 's' });
  });

  it('type sse → unsupported type-sse, regardless of gating', () => {
    const r = classifyEntries(
      { s: entry({ type: 'sse', url: 'https://example.com/sse' }) },
      { enabled: ['s'], disabled: [] },
    );
    expect(r[0]).toMatchObject({ status: 'unsupported', reason: 'type-sse' });
  });

  it('entry without usable command → unsupported no-command', () => {
    const r = classifyEntries(
      { bad: { raw: 42 }, urlish: entry({ url: 'https://x' }) },
      { enabled: ['bad', 'urlish'], disabled: [] },
    );
    expect(r[0]).toMatchObject({ status: 'unsupported', reason: 'no-command' });
    expect(r[1]).toMatchObject({ status: 'unsupported', reason: 'no-command' });
  });

  it('typeless entry WITH command gates normally (stdio inferred)', () => {
    const r = classifyEntries(
      { s: entry({ command: 'node' }) },
      { enabled: ['s'], disabled: [] },
    );
    expect(r[0]).toMatchObject({ status: 'enabled', name: 's' });
  });
});
