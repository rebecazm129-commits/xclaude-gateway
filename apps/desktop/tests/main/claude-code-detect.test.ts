// Tests for the Claude Code environment probes (claude-code-detect.ts). All
// paths are injected temp dirs — the real ~/.claude is never touched, and the
// per-process cache never engages (it only caches the dep-less call).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectClaudeCode, isHookRegistered, CCHOOK_MARKER } from '../../src/main/claude-code-detect.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xcg-ccdetect-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('detectClaudeCode', () => {
  it('installed via ~/.claude dir', () => {
    const base = tempDir();
    const claudeDir = join(base, '.claude');
    mkdirSync(claudeDir);
    expect(detectClaudeCode({ claudeDir, pathEnv: '', fallbackBinDirs: [] })).toEqual({ installed: true });
  });

  it('installed via a claude binary on PATH', () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(
      detectClaudeCode({ claudeDir: join(tempDir(), 'nope'), pathEnv: bin, fallbackBinDirs: [] }),
    ).toEqual({ installed: true });
  });

  it('installed via a fallback bin dir', () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(
      detectClaudeCode({ claudeDir: join(tempDir(), 'nope'), pathEnv: '', fallbackBinDirs: [bin] }),
    ).toEqual({ installed: true });
  });

  it('absent everywhere → not installed', () => {
    expect(
      detectClaudeCode({ claudeDir: join(tempDir(), 'nope'), pathEnv: join(tempDir(), 'also-nope'), fallbackBinDirs: [] }),
    ).toEqual({ installed: false });
  });
});

describe('isHookRegistered', () => {
  it('settings.json absent → false', () => {
    expect(isHookRegistered(join(tempDir(), 'settings.json'))).toBe(false);
  });

  it('corrupt settings.json → false, even if the marker appears in the bytes', () => {
    const p = join(tempDir(), 'settings.json');
    writeFileSync(p, `{"hooks": [ BROKEN ${CCHOOK_MARKER}`);
    expect(isHookRegistered(p)).toBe(false);
  });

  it('valid settings without the marker → false; with it → true', () => {
    const without = join(tempDir(), 'settings.json');
    writeFileSync(without, JSON.stringify({ hooks: { PostToolUse: [] } }));
    expect(isHookRegistered(without)).toBe(false);

    const withMarker = join(tempDir(), 'settings.json');
    writeFileSync(
      withMarker,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: 'command', command: 'bash -c \'"/Users/u/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"\'' }] },
          ],
        },
      }),
    );
    expect(isHookRegistered(withMarker)).toBe(true);
  });
});
