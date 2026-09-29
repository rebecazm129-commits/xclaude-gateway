// Installed Claude Code version (readClaudeCodeVersion): the binary the app
// already resolves, `--version`, local only. The runner is stubbed — no real
// binary is executed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  knownClaudeBinDirs,
  parseClaudeVersion,
  readClaudeCodeVersion,
  resolveClaudeBinary,
} from '../../src/main/claude-code-detect.js';

const tmpDirs: string[] = [];
function binDirWithClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-claude-bin-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseClaudeVersion', () => {
  it('reads the version out of `claude --version`', () => {
    expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseClaudeVersion('2.1.76')).toBe('2.1.76');
  });
  it('anything else → null', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('command not found')).toBeNull();
  });
});

describe('readClaudeCodeVersion', () => {
  it('runs --version on the resolved binary, with the autoupdater off and its dir on PATH', async () => {
    const dir = binDirWithClaude();
    const run = vi.fn(async () => '2.1.283 (Claude Code)');
    expect(await readClaudeCodeVersion({ pathEnv: dir, fallbackBinDirs: [], run })).toBe('2.1.283');
    const [binary, args, env] = run.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(binary).toBe(join(dir, 'claude'));
    expect(args).toEqual(['--version']);
    expect(env['DISABLE_AUTOUPDATER']).toBe('1');
    expect(env['PATH']?.split(':')[0]).toBe(dir);
  });

  it('no binary found → null (unknown), nothing run', async () => {
    const run = vi.fn(async () => '2.1.283');
    expect(await readClaudeCodeVersion({ pathEnv: '', fallbackBinDirs: [], run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a failing or unreadable run → null (unknown)', async () => {
    const dir = binDirWithClaude();
    expect(await readClaudeCodeVersion({ pathEnv: dir, fallbackBinDirs: [], run: async () => { throw new Error('timeout'); } })).toBeNull();
    expect(await readClaudeCodeVersion({ pathEnv: dir, fallbackBinDirs: [], run: async () => 'weird output' })).toBeNull();
  });
});

describe('resolveClaudeBinary: known locations after PATH', () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'xcg-claude-home-'));
    tmpDirs.push(dir);
    return dir;
  }
  function putClaude(dir: string, mode = 0o755): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'claude');
    writeFileSync(p, '#!/bin/sh\n', { mode });
    return p;
  }

  it('the order: ~/.npm-global/bin, ~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin', () => {
    expect(knownClaudeBinDirs('/Users/u')).toEqual([
      '/Users/u/.npm-global/bin',
      '/Users/u/.local/bin',
      '/Users/u/.claude/local',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
  });

  for (const [label, sub] of [
    ['~/.npm-global/bin', ['.npm-global', 'bin']],
    ['~/.local/bin', ['.local', 'bin']],
    ['~/.claude/local', ['.claude', 'local']],
  ] as const) {
    it(`finds claude in ${label}`, () => {
      const h = home();
      const expected = putClaude(join(h, ...sub));
      expect(resolveClaudeBinary('', knownClaudeBinDirs(h).slice(0, 3))).toBe(expected);
    });
  }

  it('/opt/homebrew/bin and /usr/local/bin are tried last, in that order', () => {
    const a = home();
    const b = home();
    const homebrew = putClaude(a);
    putClaude(b);
    // Stand-ins for the two absolute directories, in the same positions.
    expect(resolveClaudeBinary('', [join(home(), 'none'), a, b])).toBe(homebrew);
  });

  it('PATH wins over the known locations; the first executable wins', () => {
    const h = home();
    putClaude(join(h, '.local', 'bin'));
    const onPath = putClaude(join(h, 'on-path'));
    expect(resolveClaudeBinary(join(h, 'on-path'), knownClaudeBinDirs(h))).toBe(onPath);
    const npm = putClaude(join(h, '.npm-global', 'bin'));
    expect(resolveClaudeBinary('', knownClaudeBinDirs(h))).toBe(npm);
  });

  it('a claude that is not executable, or a directory named claude, is skipped', () => {
    const h = home();
    putClaude(join(h, '.npm-global', 'bin'), 0o644);
    mkdirSync(join(h, '.local', 'bin', 'claude'), { recursive: true });
    const legacy = putClaude(join(h, '.claude', 'local'));
    expect(resolveClaudeBinary('', knownClaudeBinDirs(h))).toBe(legacy);
  });

  it('readClaudeCodeVersion uses the same resolution through `home`', async () => {
    const h = home();
    putClaude(join(h, '.local', 'bin'));
    const run = vi.fn(async () => '2.1.283 (Claude Code)');
    expect(await readClaudeCodeVersion({ pathEnv: '', home: h, run })).toBe('2.1.283');
    expect((run.mock.calls[0] as unknown as [string])[0]).toBe(join(h, '.local', 'bin', 'claude'));
  });
});
