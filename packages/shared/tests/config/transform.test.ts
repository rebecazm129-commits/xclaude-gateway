import { describe, it, expect } from 'vitest';

import { parseConfig } from '../../src/config/parser.js';
import { addRemoteToConfig, applyWrap, createRemoteEntry, unwrap } from '../../src/config/transform.js';
import type { WrapPlan } from '../../src/config/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

// Build a WrapPlan that targets the given names as wrappable. Avoids going
// through the parser for tests that focus on transform behavior in isolation.
function plan(...names: string[]): WrapPlan {
  return { entries: names.map((name) => ({ kind: 'wrappable' as const, name, original: { command: '' } })) };
}

const XCG = '/Users/r/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy';

describe('applyWrap — pure transformation (Milestone 4 Phase 2)', () => {
  it('wraps a single entry with the exact wrapper contract', () => {
    const raw = { mcpServers: { fs: { command: '/usr/local/bin/npx', args: ['@mcpf/filesystem', '/x'] } } };
    const out = applyWrap(raw, plan('fs'), XCG) as any;
    expect(out.mcpServers.fs).toEqual({
      command: XCG,
      args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/filesystem', '/x'],
    });
  });

  it('does not mutate the input', () => {
    const raw = { mcpServers: { fs: { command: 'X', args: ['a'] } } };
    const snapshot = JSON.parse(JSON.stringify(raw));
    applyWrap(raw, plan('fs'), XCG);
    expect(raw).toEqual(snapshot);
  });

  it('preserves env and cwd on the wrapped entry', () => {
    const raw = { mcpServers: { g: { command: 'node', args: ['s.js'], env: { TOKEN: 'abc' }, cwd: '/work' } } };
    const out = applyWrap(raw, plan('g'), XCG) as any;
    expect(out.mcpServers.g.env).toEqual({ TOKEN: 'abc' });
    expect(out.mcpServers.g.cwd).toBe('/work');
  });

  it('preserves unknown keys on the entry (custom fields like description, icon)', () => {
    const raw = { mcpServers: { x: { command: 'node', args: [], description: 'desc', icon: 'i.png' } } };
    const out = applyWrap(raw, plan('x'), XCG) as any;
    expect(out.mcpServers.x.description).toBe('desc');
    expect(out.mcpServers.x.icon).toBe('i.png');
  });

  it('preserves unknown top-level keys outside mcpServers', () => {
    const raw = { mcpServers: { a: { command: 'c' } }, theme: 'dark', other: { nested: 1 } };
    const out = applyWrap(raw, plan('a'), XCG) as any;
    expect(out.theme).toBe('dark');
    expect(out.other).toEqual({ nested: 1 });
  });

  it('leaves skipped entries (not in plan) untouched', () => {
    const raw = { mcpServers: { a: { command: 'c', args: ['x'] }, b: { url: 'https://r' } } };
    const out = applyWrap(raw, plan('a'), XCG) as any;
    expect(out.mcpServers.a.command).toBe(XCG);
    expect(out.mcpServers.b).toEqual({ url: 'https://r' });
  });

  it('idempotent: applying through parse+plan twice equals applying once', () => {
    // Realistic loop: write config, parse, applyWrap, write, parse again, applyWrap again.
    const tmp = mkdtempSync(join(osTmpdir(), 'xcg-transform-idem-'));
    try {
      const p = join(tmp, 'cfg.json');
      writeFileSync(p, JSON.stringify({ mcpServers: { fs: { command: '/usr/local/bin/npx', args: ['@mcpf/fs'] } } }));
      const r1 = parseConfig(p);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const once = applyWrap(r1.raw, r1.plan, XCG);
      writeFileSync(p, JSON.stringify(once));
      const r2 = parseConfig(p);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      // After the first wrap, fs is detected as already-wrapped → plan.entries
      // for fs is kind:'skipped', so the second applyWrap is a no-op on it.
      const twice = applyWrap(r2.raw, r2.plan, XCG);
      expect(twice).toEqual(once);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('unwrap — inverse of applyWrap', () => {
  it('roundtrip: wrap then unwrap restores the original entry', () => {
    const raw = { mcpServers: { fs: { command: '/usr/local/bin/npx', args: ['@mcpf/filesystem', '/x'] } } };
    const wrapped = applyWrap(raw, plan('fs'), XCG);
    const back = unwrap(wrapped) as any;
    expect(back.mcpServers.fs).toEqual({ command: '/usr/local/bin/npx', args: ['@mcpf/filesystem', '/x'] });
  });

  it('roundtrip preserves env, cwd and unknown keys', () => {
    const raw = {
      mcpServers: {
        g: { command: 'node', args: ['s.js'], env: { T: '1' }, cwd: '/w', description: 'd' },
      },
      theme: 'dark',
    };
    const wrapped = applyWrap(raw, plan('g'), XCG);
    const back = unwrap(wrapped) as any;
    expect(back.mcpServers.g).toEqual({ command: 'node', args: ['s.js'], env: { T: '1' }, cwd: '/w', description: 'd' });
    expect(back.theme).toBe('dark');
  });

  it('leaves non-wrapped entries untouched', () => {
    const raw = { mcpServers: { a: { command: 'c', args: ['x'] }, b: { url: 'https://r' } } };
    const out = unwrap(raw) as any;
    expect(out.mcpServers.a).toEqual({ command: 'c', args: ['x'] });
    expect(out.mcpServers.b).toEqual({ url: 'https://r' });
  });

  it('unwrap is idempotent: unwrap(unwrap(x)) === unwrap(x)', () => {
    const raw = { mcpServers: { fs: { command: '/n', args: ['a'] } } };
    const wrapped = applyWrap(raw, plan('fs'), XCG);
    const once = unwrap(wrapped);
    const twice = unwrap(once);
    expect(twice).toEqual(once);
  });

  it('handles entry with wrapper basename but non-matching args (does NOT unwrap)', () => {
    // Same false-positive guard as F1: basename xcg-proxy but args do not
    // match the contract → not wrapped → unwrap is a no-op for this entry.
    const raw = { mcpServers: { tricky: { command: '/some/xcg-proxy', args: ['serve', '--port', '9'] } } };
    const out = unwrap(raw) as any;
    expect(out.mcpServers.tricky).toEqual({ command: '/some/xcg-proxy', args: ['serve', '--port', '9'] });
  });

  it('unwraps a legacy pre-2.b wrap shape (back-compat)', () => {
    // Input was wrapped by an older xcg-config (before the 'stdio' subcommand).
    // The new unwrap recognizes both forms; this verifies the legacy path.
    const legacy = {
      mcpServers: {
        fs: {
          command: XCG,
          args: ['--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/filesystem', '/x'],
        },
      },
    };
    const back = unwrap(legacy) as any;
    expect(back.mcpServers.fs).toEqual({
      command: '/usr/local/bin/npx',
      args: ['@mcpf/filesystem', '/x'],
    });
  });
});

describe('createRemoteEntry / addRemoteToConfig — remote bridge (Hito 6 Phase 5)', () => {
  const URL_OK = 'https://mcp.notion.com/mcp';

  it('createRemoteEntry: exact bridge shape', () => {
    expect(createRemoteEntry('notion', URL_OK, '/x/xcg-proxy')).toEqual({
      command: '/x/xcg-proxy',
      args: ['http', '--url', URL_OK, '--name', 'notion'],
    });
  });

  it('inserts into an empty config', () => {
    const res = addRemoteToConfig({}, 'notion', URL_OK, '/x/xcg-proxy');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.config as any).mcpServers.notion).toEqual({
      command: '/x/xcg-proxy',
      args: ['http', '--url', URL_OK, '--name', 'notion'],
    });
  });

  it('preserves existing entries and unknown top-level keys', () => {
    const raw = {
      theme: 'dark',
      mcpServers: { fs: { command: 'npx', args: ['-y', 'fs'] } },
    };
    const res = addRemoteToConfig(raw, 'notion', URL_OK, '/x/xcg-proxy');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cfg = res.config as any;
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', 'fs'] });
    expect(cfg.mcpServers.notion).toEqual({
      command: '/x/xcg-proxy',
      args: ['http', '--url', URL_OK, '--name', 'notion'],
    });
  });

  it('does not mutate the input', () => {
    const raw = { theme: 'dark', mcpServers: { fs: { command: 'npx' } } };
    const before = JSON.stringify(raw);
    addRemoteToConfig(raw, 'notion', URL_OK, '/x/xcg-proxy');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('rejects an invalid name', () => {
    expect(addRemoteToConfig({}, 'a b', URL_OK, '/x/xcg-proxy')).toEqual({
      ok: false,
      error: 'invalid-name',
    });
  });

  it('rejects an invalid url', () => {
    expect(addRemoteToConfig({}, 'notion', 'not-a-url', '/x/xcg-proxy')).toEqual({
      ok: false,
      error: 'invalid-url',
    });
  });

  it('rejects a name that already exists', () => {
    const raw = { mcpServers: { notion: { command: 'x' } } };
    expect(addRemoteToConfig(raw, 'notion', URL_OK, '/x/xcg-proxy')).toEqual({
      ok: false,
      error: 'name-exists',
    });
  });

  it('rejects a non-object raw (null / array)', () => {
    expect(addRemoteToConfig(null, 'notion', URL_OK, '/x/xcg-proxy')).toEqual({
      ok: false,
      error: 'bad-config',
    });
    expect(addRemoteToConfig([], 'notion', URL_OK, '/x/xcg-proxy')).toEqual({
      ok: false,
      error: 'bad-config',
    });
  });
});
