import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSafeRemoteName, parseConfig } from '../../src/config/parser.js';

describe('parseConfig — read-only classifier (Milestone 4 Phase 1)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-config-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Writes a fixture config and returns its path. Never touches the real
  // user config — everything lives under the per-test tmp dir.
  function writeConfig(content: object | string): string {
    const p = join(tmp, 'claude_desktop_config.json');
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
  }

  it('classifies a mixed config: wrappable, already-wrapped, no-command', () => {
    const path = writeConfig({
      mcpServers: {
        fs: { command: '/usr/local/bin/npx', args: ['@mcpf/filesystem', '/x'] },
        wrapped: {
          command: '/Applications/X.app/Contents/Resources/proxy/bin/xcg-proxy',
          args: ['--wrap', 'npx', '--name', 'wrapped', '--', '@mcpf/fs'],
        },
        remote: { url: 'https://example.com/sse' },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries).toEqual([
      {
        kind: 'wrappable',
        name: 'fs',
        original: { command: '/usr/local/bin/npx', args: ['@mcpf/filesystem', '/x'] },
        transport: 'stdio',
        endpoint: '/usr/local/bin/npx',
      },
      { kind: 'skipped', name: 'wrapped', reason: 'already-wrapped', transport: 'stdio', endpoint: 'npx' },
      { kind: 'skipped', name: 'remote', reason: 'no-command', transport: null, endpoint: null },
    ]);
  });

  it('classifies a NEW-shape wrapped entry (post 2.b) as already-wrapped', () => {
    const path = writeConfig({
      mcpServers: {
        wrapped_new: {
          command: '/Applications/X.app/Contents/Resources/proxy/bin/xcg-proxy',
          args: ['stdio', '--wrap', 'npx', '--name', 'wrapped_new', '--', '@mcpf/fs'],
        },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'skipped',
      name: 'wrapped_new',
      reason: 'already-wrapped',
      transport: 'stdio',
      endpoint: 'npx',
    });
  });

  it('preserves env and cwd on a wrappable entry', () => {
    const path = writeConfig({
      mcpServers: {
        g: {
          command: 'node',
          args: ['srv.js'],
          env: { TOKEN: 'abc' },
          cwd: '/work',
        },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'wrappable',
      name: 'g',
      original: { command: 'node', args: ['srv.js'], env: { TOKEN: 'abc' }, cwd: '/work' },
      transport: 'stdio',
      endpoint: 'node',
    });
  });

  it('absent mcpServers is valid: empty plan, not an error', () => {
    const path = writeConfig({ otherKey: 1 });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries).toEqual([]);
  });

  it('empty mcpServers object: empty plan', () => {
    const path = writeConfig({ mcpServers: {} });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries).toEqual([]);
  });

  it('malformed JSON: invalid-json error, never throws', () => {
    const path = writeConfig('{ not valid json');
    const r = parseConfig(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-json');
  });

  it('missing file: not-found error', () => {
    const r = parseConfig(join(tmp, 'does-not-exist.json'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not-found');
  });

  it('root not an object: unexpected-shape', () => {
    const path = writeConfig('[]');
    const r = parseConfig(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unexpected-shape');
  });

  it('mcpServers not an object: unexpected-shape', () => {
    const path = writeConfig({ mcpServers: ['x'] });
    const r = parseConfig(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unexpected-shape');
  });

  it('xcg-proxy basename but args do NOT match contract: wrappable (no false positive)', () => {
    const path = writeConfig({
      mcpServers: {
        tricky: { command: '/some/where/xcg-proxy', args: ['serve', '--port', '9'] },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'wrappable',
      name: 'tricky',
      original: { command: '/some/where/xcg-proxy', args: ['serve', '--port', '9'] },
      transport: 'stdio',
      endpoint: '/some/where/xcg-proxy',
    });
  });

  it('entry with non-string command: no-command skip', () => {
    const path = writeConfig({ mcpServers: { bad: { command: 42 } } });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({ kind: 'skipped', name: 'bad', reason: 'no-command', transport: null, endpoint: null });
  });

  it('a remote http-bridge entry is detected as already-wrapped (Hito 6 Phase 5)', () => {
    const path = writeConfig({
      mcpServers: {
        notion: {
          command: '/x/xcg-proxy',
          args: ['http', '--url', 'https://mcp.notion.com/mcp', '--name', 'notion'],
        },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'skipped',
      name: 'notion',
      reason: 'already-wrapped',
      transport: 'http',
      endpoint: 'https://mcp.notion.com/mcp',
    });
  });

  it('xcg-proxy + http but incomplete form: wrappable (no false positive)', () => {
    const path = writeConfig({
      mcpServers: {
        partial: { command: '/x/xcg-proxy', args: ['http', '--url', 'https://x'] },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'wrappable',
      name: 'partial',
      original: { command: '/x/xcg-proxy', args: ['http', '--url', 'https://x'] },
      transport: 'stdio',
      endpoint: '/x/xcg-proxy',
    });
  });

  it('http form but command is NOT xcg-proxy: wrappable (not ours)', () => {
    const path = writeConfig({
      mcpServers: {
        other: { command: '/usr/bin/other', args: ['http', '--url', 'https://x', '--name', 'other'] },
      },
    });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({
      kind: 'wrappable',
      name: 'other',
      original: { command: '/usr/bin/other', args: ['http', '--url', 'https://x', '--name', 'other'] },
      transport: 'stdio',
      endpoint: '/usr/bin/other',
    });
  });
});

describe('classifyEntry transport/endpoint enrichment (Connectors Fase 1)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-config-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function entryFor(entry: object): { transport?: string | null; endpoint?: string | null } {
    const p = join(tmp, 'claude_desktop_config.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { e: entry } }));
    const r = parseConfig(p);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    return r.plan.entries[0] as { transport?: string | null; endpoint?: string | null };
  }

  it('already-wrapped http: transport http, endpoint = the remote url', () => {
    const e = entryFor({
      command: '/x/xcg-proxy',
      args: ['http', '--url', 'https://mcp.linear.app/mcp', '--name', 'linear'],
    });
    expect(e.transport).toBe('http');
    expect(e.endpoint).toBe('https://mcp.linear.app/mcp');
  });

  it('already-wrapped stdio: transport stdio, endpoint = the wrapped command', () => {
    const e = entryFor({
      command: '/x/xcg-proxy',
      args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '-y', '@mcpf/fs'],
    });
    expect(e.transport).toBe('stdio');
    expect(e.endpoint).toBe('/usr/local/bin/npx');
  });

  it('already-wrapped legacy --wrap: transport stdio, endpoint = the wrapped command', () => {
    const e = entryFor({
      command: '/x/xcg-proxy',
      args: ['--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '-y', '@mcpf/fs'],
    });
    expect(e.transport).toBe('stdio');
    expect(e.endpoint).toBe('/usr/local/bin/npx');
  });

  it('wrappable (unwrapped local): transport stdio, endpoint = command', () => {
    const e = entryFor({ command: 'node', args: ['server.js'] });
    expect(e.transport).toBe('stdio');
    expect(e.endpoint).toBe('node');
  });

  it('no-command: transport null, endpoint null', () => {
    const e = entryFor({ url: 'https://example.com/sse' });
    expect(e.transport).toBeNull();
    expect(e.endpoint).toBeNull();
  });
});

describe('isSafeRemoteName — validates xCLAUDE-chosen remote names (Hito 6 Phase 5)', () => {
  it('accepts normal names', () => {
    for (const n of ['notion', 'github', 'my-server', 'srv_1', 'a.b']) {
      expect(isSafeRemoteName(n)).toBe(true);
    }
  });

  it('rejects empty and names with unsafe characters', () => {
    for (const n of ['', 'a b', 'a\nb', 'a"b', 'a/b', 'a;b']) {
      expect(isSafeRemoteName(n)).toBe(false);
    }
  });

  it('rejects a 65-char name (over the limit)', () => {
    expect(isSafeRemoteName('a'.repeat(65))).toBe(false);
  });

  it('accepts a 64-char name (at the limit)', () => {
    expect(isSafeRemoteName('a'.repeat(64))).toBe(true);
  });
});
