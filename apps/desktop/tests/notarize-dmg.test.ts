// Unit tests for the afterAllArtifactBuild DMG-notarization hook (frente 3).
// The external commands (xcrun notarytool/stapler) are mocked; the .app
// discovery walks a real tmp outDir. No real notarization here — the live
// validation of the hook is the beta.4 build.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();

// CJS interop: module.exports.default is the hook. The mock exec goes in as
// the hook's test-only second argument (vi.mock can't intercept builtins
// required from an externalized .cjs — verified 17/07).
import * as hookModule from '../scripts/notarize-dmg.cjs';
const hook = (
  hookModule as { default: (r: unknown, exec?: unknown) => Promise<string[]> }
).default;
const notarizeDmg = (r: unknown): Promise<string[]> => hook(r, execFileSync);

let outDir: string;
let dmgPath: string;
const savedEnv: Record<string, string | undefined> = {};

function buildResult(artifactPaths?: string[]): unknown {
  return { outDir, artifactPaths: artifactPaths ?? [dmgPath], configuration: {} };
}

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'xcg-notarize-'));
  dmgPath = join(outDir, 'xCLAUDE Gateway-1.0.0-beta.4-arm64.dmg');
  await mkdir(join(outDir, 'mac-arm64', 'xCLAUDE Gateway.app'), { recursive: true });
  savedEnv['APPLE_KEYCHAIN_PROFILE'] = process.env['APPLE_KEYCHAIN_PROFILE'];
  savedEnv['XCG_SKIP_DMG_NOTARIZE'] = process.env['XCG_SKIP_DMG_NOTARIZE'];
  delete process.env['APPLE_KEYCHAIN_PROFILE'];
  delete process.env['XCG_SKIP_DMG_NOTARIZE'];
  execFileSync.mockReset();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(outDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('notarize-dmg hook — guards', () => {
  it('XCG_SKIP_DMG_NOTARIZE=1 → skips everything with an unmissable warning, no commands run', async () => {
    process.env['XCG_SKIP_DMG_NOTARIZE'] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(notarizeDmg(buildResult())).resolves.toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join('\n')).toContain('NOT distributable');
  });

  it('missing APPLE_KEYCHAIN_PROFILE → hard error naming the env var and the opt-out', async () => {
    await expect(notarizeDmg(buildResult())).rejects.toThrow(
      /APPLE_KEYCHAIN_PROFILE.*XCG_SKIP_DMG_NOTARIZE/s,
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('no .dmg among artifacts → hard error (never a silent no-op)', async () => {
    process.env['APPLE_KEYCHAIN_PROFILE'] = 'xclaude-notary';
    await expect(notarizeDmg(buildResult([join(outDir, 'app.zip')]))).rejects.toThrow(
      /no \.dmg/,
    );
  });

  it('un-stapled .app (integrated notarization silently skipped) → abort explaining it', async () => {
    process.env['APPLE_KEYCHAIN_PROFILE'] = 'xclaude-notary';
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('validate failed'), { stdout: '', stderr: 'does not have a ticket' });
    });
    await expect(notarizeDmg(buildResult())).rejects.toThrow(/skips SILENTLY|not stapled/);
    // Only the .app validate ran; the DMG was never submitted.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0]?.[1]).toEqual([
      'stapler', 'validate', join(outDir, 'mac-arm64', 'xCLAUDE Gateway.app'),
    ]);
  });
});

describe('notarize-dmg hook — submit/staple flow', () => {
  beforeEach(() => {
    process.env['APPLE_KEYCHAIN_PROFILE'] = 'xclaude-notary';
  });

  it('happy path: validate .app → submit --wait (Accepted) → staple → validate, in order', async () => {
    execFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a[0] === 'notarytool') return 'Processing complete\n  id: x\n  status: Accepted\n';
      return '';
    });
    await expect(notarizeDmg(buildResult())).resolves.toEqual([]);
    const calls = execFileSync.mock.calls.map((c) => c[1] as string[]);
    expect(calls).toEqual([
      ['stapler', 'validate', join(outDir, 'mac-arm64', 'xCLAUDE Gateway.app')],
      ['notarytool', 'submit', dmgPath, '--keychain-profile', 'xclaude-notary', '--wait'],
      ['stapler', 'staple', dmgPath],
      ['stapler', 'validate', dmgPath],
    ]);
  });

  it('submit ends non-Accepted → abort including notarytool output; no staple attempted', async () => {
    execFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a[0] === 'notarytool') return 'Processing complete\n  id: x\n  status: Invalid\n';
      return '';
    });
    await expect(notarizeDmg(buildResult())).rejects.toThrow(/Accepted[\s\S]*status: Invalid/);
    const calls = execFileSync.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(calls).toEqual(['stapler', 'notarytool']); // never reached staple
  });

  it('staple failure → abort with the command detail', async () => {
    execFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a[0] === 'notarytool') return 'status: Accepted';
      if (a[0] === 'stapler' && a[1] === 'staple') {
        throw Object.assign(new Error('boom'), { stdout: '', stderr: 'CloudKit query failed' });
      }
      return '';
    });
    await expect(notarizeDmg(buildResult())).rejects.toThrow(/CloudKit query failed/);
  });
});
