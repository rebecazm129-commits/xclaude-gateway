// Tolerant readers for Claude Code project config, exercised against the
// REAL spike 3 captures in tests/fixtures/config-cc/ (see its README for
// provenance and sanitization policy).

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readMcpJson, readSettingsLocal } from '../../src/config-cc/parser.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));

describe('config-cc fixtures — sanitization guard', () => {
  // Executable invariant, not convention (see fixtures/config-cc/README.md):
  // fixtures are real captures and MUST be sanitized (username → "user").
  it('no fixture leaks a real /Users/<name> path', () => {
    // README.md documents the policy and legitimately contains the literal
    // "/Users/..." — only the capture files are scanned, same as cchook's
    // guard (which filters by extension).
    for (const name of readdirSync(FIXTURE_DIR).filter((f) => !f.endsWith('.md'))) {
      const content = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      for (const m of content.matchAll(/\/Users\/([^/"\s]+)/g)) {
        expect(m[1], `${name} leaks /Users/${m[1]}`).toBe('user');
      }
    }
  });
});

describe('readMcpJson — tolerant .mcp.json reader (F2.1a)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Installs a fixture (or literal content) at the project-scope path
  // resolveScopeFiles dictates, and returns that path — the tests exercise
  // the scopes → parser composition, not hand-built paths.
  function installMcpJson(fixtureOrContent: { fixture: string } | { content: string }): string {
    const path = resolveScopeFiles({ scope: 'project', projectDir }).entriesPath;
    if ('fixture' in fixtureOrContent) {
      copyFileSync(join(FIXTURE_DIR, fixtureOrContent.fixture), path);
    } else {
      writeFileSync(path, fixtureOrContent.content);
    }
    return path;
  }

  it('paso3 fixture: stdio entry verbatim — explicit type, absolute args, empty env kept', () => {
    const r = readMcpJson(installMcpJson({ fixture: 'mcp.json.paso3' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.present).toBe(true);
    expect(r.servers).toEqual({
      'toy-stdio': {
        type: 'stdio',
        command: 'node',
        args: ['/Users/user/spikes/xcg-spike3/toy-server.js'],
        env: {},
        raw: {
          type: 'stdio',
          command: 'node',
          args: ['/Users/user/spikes/xcg-spike3/toy-server.js'],
          env: {},
        },
      },
    });
  });

  it('paso4 fixture: appended http entry is minimal — type + url only', () => {
    const r = readMcpJson(installMcpJson({ fixture: 'mcp.json.paso4' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.servers)).toEqual(['toy-stdio', 'toy-http']);
    expect(r.servers['toy-http']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      raw: { type: 'http', url: 'https://example.com/mcp' },
    });
  });

  it('absent .mcp.json ≡ empty (spike 3 paso 7): ok, present:false, zero servers', () => {
    const r = readMcpJson(resolveScopeFiles({ scope: 'project', projectDir }).entriesPath);
    expect(r).toEqual({ ok: true, present: false, servers: {}, raw: undefined });
  });

  it('present but mcpServers key absent: ok, present:true, zero servers', () => {
    const r = readMcpJson(installMcpJson({ content: '{ "otherKey": 1 }' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.present).toBe(true);
    expect(r.servers).toEqual({});
  });

  it('corrupt JSON: invalid-json error result, never throws', () => {
    const r = readMcpJson(installMcpJson({ content: '{ not valid json' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-json');
  });

  it('root not an object: unexpected-shape', () => {
    const r = readMcpJson(installMcpJson({ content: '[]' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unexpected-shape');
  });

  it('mcpServers not an object: unexpected-shape', () => {
    const r = readMcpJson(installMcpJson({ content: '{ "mcpServers": ["x"] }' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unexpected-shape');
  });

  it('exposes the parsed file as raw for the F2.1b writer', () => {
    const r = readMcpJson(installMcpJson({ fixture: 'mcp.json.paso4' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.raw as { mcpServers: object }).mcpServers).toBeDefined();
  });
});

describe('readSettingsLocal — gating file reader (F2.1a)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function installSettings(fixtureOrContent: { fixture: string } | { content: string }): string {
    const path = resolveScopeFiles({ scope: 'project', projectDir }).gatingPath;
    expect(path).toBeDefined();
    if (path === undefined) throw new Error('unreachable');
    mkdirSync(dirname(path), { recursive: true });
    if ('fixture' in fixtureOrContent) {
      copyFileSync(join(FIXTURE_DIR, fixtureOrContent.fixture), path);
    } else {
      writeFileSync(path, fixtureOrContent.content);
    }
    return path;
  }

  it('paso6 fixture (approve-all): ONLY enabledMcpjsonServers, disabled ≡ []', () => {
    const r = readSettingsLocal(installSettings({ fixture: 'settings.local.json.paso6' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.present).toBe(true);
    expect(r.enabled).toEqual(['toy-stdio', 'toy-http']);
    expect(r.disabled).toEqual([]);
  });

  it('pasoB fixture (reject-all): ONLY disabledMcpjsonServers, enabled ≡ []', () => {
    const r = readSettingsLocal(installSettings({ fixture: 'settings.local.json.pasoB-rechazo' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.present).toBe(true);
    expect(r.enabled).toEqual([]);
    expect(r.disabled).toEqual(['toy-stdio', 'toy-http']);
  });

  it('absent file ≡ no decision: ok, present:false, both lists empty', () => {
    const path = resolveScopeFiles({ scope: 'project', projectDir }).gatingPath;
    if (path === undefined) throw new Error('unreachable');
    const r = readSettingsLocal(path);
    expect(r).toEqual({ ok: true, present: false, enabled: [], disabled: [], raw: undefined });
  });

  it('corrupt JSON: invalid-json error result, never throws', () => {
    const r = readSettingsLocal(installSettings({ content: '{ nope' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-json');
  });

  it('malformed lists degrade fail-safe: non-array ≡ [], non-string members dropped', () => {
    const r = readSettingsLocal(installSettings({
      content: JSON.stringify({
        enabledMcpjsonServers: 'toy-stdio',
        disabledMcpjsonServers: ['toy-http', 42],
      }),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.enabled).toEqual([]);
    expect(r.disabled).toEqual(['toy-http']);
  });
});
