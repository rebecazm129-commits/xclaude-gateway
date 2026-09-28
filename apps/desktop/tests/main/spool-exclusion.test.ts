// The app excludes the Claude Code spool from Time Machine and verifies it;
// any failure is logged and changes nothing else.

import { describe, expect, it, vi } from 'vitest';

import { excludeSpoolFromTimeMachine } from '../../src/main/spool-exclusion.js';

const DIR = '/Users/you/Library/Application Support/xCLAUDE Gateway/claude-code/spool';

describe('excludeSpoolFromTimeMachine', () => {
  it('creates the folder, adds the exclusion without -p, then verifies it', async () => {
    const mkdir = vi.fn();
    const run = vi.fn(async (_cmd: string, args: readonly string[]) =>
      args[0] === 'isexcluded' ? `[Excluded]    ${DIR}\n` : '',
    );
    const log = vi.fn();
    expect(await excludeSpoolFromTimeMachine({ spoolDir: DIR, platform: 'darwin', mkdir, run, log })).toBe('excluded');
    expect(mkdir).toHaveBeenCalledWith(DIR);
    expect(run.mock.calls).toEqual([
      ['/usr/bin/tmutil', ['addexclusion', DIR]],
      ['/usr/bin/tmutil', ['isexcluded', DIR]],
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('an exclusion tmutil does not confirm is logged as failed', async () => {
    const log = vi.fn();
    const run = vi.fn(async (_cmd: string, args: readonly string[]) => (args[0] === 'isexcluded' ? `[Included]    ${DIR}\n` : ''));
    expect(await excludeSpoolFromTimeMachine({ spoolDir: DIR, platform: 'darwin', mkdir: vi.fn(), run, log })).toBe('failed');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a tmutil error is logged, never thrown', async () => {
    const log = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('tmutil: permission denied');
    });
    expect(await excludeSpoolFromTimeMachine({ spoolDir: DIR, platform: 'darwin', mkdir: vi.fn(), run, log })).toBe('failed');
    expect(log.mock.calls[0]![0]).toContain('permission denied');
  });

  it('not macOS: nothing to do', async () => {
    const run = vi.fn();
    expect(await excludeSpoolFromTimeMachine({ spoolDir: DIR, platform: 'linux', run })).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });
});
