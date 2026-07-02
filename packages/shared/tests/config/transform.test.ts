import { describe, it, expect } from 'vitest';

import { parseConfig } from '../../src/config/parser.js';
import {
  addRemoteToConfig,
  applyWrap,
  createRemoteEntry,
  removeRemoteFromConfig,
  unwrap,
} from '../../src/config/transform.js';
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

describe('applyWrap — only parameter (single-connector wrap)', () => {
  it('only=<wrappable> wraps just that entry; other wrappables stay byte-for-byte', () => {
    const raw = {
      mcpServers: {
        a: { command: '/usr/local/bin/npx', args: ['@mcpf/a'] },
        b: { command: 'node', args: ['b.js'] },
      },
    };
    // Both a and b are wrappable in the plan, but only 'a' is requested.
    const out = applyWrap(raw, plan('a', 'b'), XCG, 'a') as any;
    expect(out.mcpServers.a).toEqual({
      command: XCG,
      args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'a', '--', '@mcpf/a'],
    });
    // b is left exactly as the original, despite being wrappable.
    expect(out.mcpServers.b).toEqual({ command: 'node', args: ['b.js'] });
  });

  it('only=<name present but not wrappable> wraps nothing (result equals raw)', () => {
    const raw = {
      mcpServers: {
        a: { command: 'npx', args: ['-y', 'a'] }, // wrappable
        b: { url: 'https://r' }, // present in config but not a wrappable target
      },
    };
    const out = applyWrap(raw, plan('a'), XCG, 'b');
    expect(out).toEqual(raw);
  });

  it('only=<inexistent name> wraps nothing (result equals raw)', () => {
    const raw = { mcpServers: { a: { command: 'npx', args: ['-y', 'a'] } } };
    const out = applyWrap(raw, plan('a'), XCG, 'zzz');
    expect(out).toEqual(raw);
  });
});

describe('applyWrap — re-home already-wrapped entries to xcgPath (H4)', () => {
  // A wrap written against the dev tree bin (basename xcg-proxy, valid contract
  // args) — recognized as already-wrapped, but pointing at a non-canonical path.
  const DEV = '/Users/r/code/xclaude-gateway/packages/proxy/bin/xcg-proxy';

  it('a) stdio form at a dev path → command re-homed to xcgPath, args/env/cwd intact', () => {
    const raw = {
      mcpServers: {
        fs: {
          command: DEV,
          args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/fs'],
          env: { TOKEN: 'abc' },
          cwd: '/work',
        },
      },
    };
    // Empty wrappable plan: fs is not a wrap target (it's already-wrapped).
    const out = applyWrap(raw, plan(), XCG) as any;
    expect(out.mcpServers.fs).toEqual({
      command: XCG,
      args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/fs'],
      env: { TOKEN: 'abc' },
      cwd: '/work',
    });
  });

  it('a) legacy --wrap form at a dev path → command re-homed, args verbatim', () => {
    const raw = {
      mcpServers: {
        fs: { command: DEV, args: ['--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/fs'] },
      },
    };
    const out = applyWrap(raw, plan(), XCG) as any;
    expect(out.mcpServers.fs).toEqual({
      command: XCG,
      args: ['--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '@mcpf/fs'],
    });
  });

  it('b) already-wrapped at xcgPath → untouched (byte-identical, same reference)', () => {
    const entry = { command: XCG, args: ['stdio', '--wrap', 'npx', '--name', 'fs', '--', 'a'] };
    const raw = { mcpServers: { fs: entry } };
    const out = applyWrap(raw, plan(), XCG) as any;
    expect(out.mcpServers.fs).toEqual(entry);
    expect(out.mcpServers.fs).toBe(entry); // no rewrite: same object reference
  });

  it('c) http/remote bridge at a dev path → same re-homing', () => {
    const raw = {
      mcpServers: {
        notion: { command: DEV, args: ['http', '--url', 'https://mcp.notion.com/mcp', '--name', 'notion'] },
      },
    };
    const out = applyWrap(raw, plan(), XCG) as any;
    expect(out.mcpServers.notion).toEqual({
      command: XCG,
      args: ['http', '--url', 'https://mcp.notion.com/mcp', '--name', 'notion'],
    });
  });

  it('does NOT re-home an entry whose command basename is not xcg-proxy', () => {
    const entry = { command: '/usr/bin/other', args: ['stdio', '--wrap', 'x', '--name', 'a', '--'] };
    const raw = { mcpServers: { a: entry } };
    const out = applyWrap(raw, plan(), XCG) as any;
    expect(out.mcpServers.a).toEqual(entry);
  });

  it('only=<X> re-homes X but leaves a different already-wrapped sibling untouched', () => {
    const raw = {
      mcpServers: {
        a: { command: 'npx', args: ['-y', 'a'] }, // wrappable
        b: { command: DEV, args: ['stdio', '--wrap', 'nb', '--name', 'b', '--'] }, // already-wrapped, dev path
      },
    };
    const out = applyWrap(raw, plan('a'), XCG, 'a') as any;
    expect(out.mcpServers.a.command).toBe(XCG);
    expect(out.mcpServers.b).toEqual({ command: DEV, args: ['stdio', '--wrap', 'nb', '--name', 'b', '--'] });
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

describe('removeRemoteFromConfig — delete a remote bridge (Hito 6 Phase 5)', () => {
  const URL_OK = 'https://mcp.notion.com/mcp';
  const ours = () => ({
    command: '/x/xcg-proxy',
    args: ['http', '--url', URL_OK, '--name', 'notion'],
  });

  it('removes one of our remote entries', () => {
    const raw = { mcpServers: { notion: ours(), fs: { command: 'npx', args: ['-y', 'fs'] } } };
    const res = removeRemoteFromConfig(raw, 'notion');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.removed).toBe(true);
    const cfg = res.config as any;
    expect('notion' in cfg.mcpServers).toBe(false);
    expect(cfg.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', 'fs'] });
  });

  it('does NOT remove an entry that is not ours', () => {
    const raw = { mcpServers: { notion: { command: 'npx', args: ['-y', 'foo'] } } };
    const res = removeRemoteFromConfig(raw, 'notion');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.removed).toBe(false);
    expect((res.config as any).mcpServers.notion).toEqual({ command: 'npx', args: ['-y', 'foo'] });
  });

  it('non-existent name: removed false, config intact', () => {
    const raw = { mcpServers: { fs: { command: 'npx' } } };
    const res = removeRemoteFromConfig(raw, 'notion');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.removed).toBe(false);
    expect((res.config as any).mcpServers.fs).toEqual({ command: 'npx' });
  });

  it('preserves other entries and unknown top-level keys on removal', () => {
    const raw = {
      theme: 'dark',
      mcpServers: { notion: ours(), fs: { command: 'npx', args: ['-y', 'fs'] } },
    };
    const res = removeRemoteFromConfig(raw, 'notion');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cfg = res.config as any;
    expect(cfg.theme).toBe('dark');
    expect('notion' in cfg.mcpServers).toBe(false);
    expect(cfg.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', 'fs'] });
  });

  it('does not mutate the input', () => {
    const raw = { theme: 'dark', mcpServers: { notion: ours() } };
    const before = JSON.stringify(raw);
    removeRemoteFromConfig(raw, 'notion');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('rejects a non-object raw', () => {
    expect(removeRemoteFromConfig(null, 'notion')).toEqual({ ok: false, error: 'bad-config' });
    expect(removeRemoteFromConfig([], 'notion')).toEqual({ ok: false, error: 'bad-config' });
  });
});
