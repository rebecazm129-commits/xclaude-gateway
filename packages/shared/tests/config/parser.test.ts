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
      },
      { kind: 'skipped', name: 'wrapped', reason: 'already-wrapped' },
      { kind: 'skipped', name: 'remote', reason: 'no-command' },
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
    });
  });

  it('entry with non-string command: no-command skip', () => {
    const path = writeConfig({ mcpServers: { bad: { command: 42 } } });
    const r = parseConfig(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entries[0]).toEqual({ kind: 'skipped', name: 'bad', reason: 'no-command' });
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
