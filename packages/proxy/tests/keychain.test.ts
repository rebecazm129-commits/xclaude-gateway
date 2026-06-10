import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => unknown)(...args),
}));

import { keychainSet } from '../src/keychain.js';

describe('keychainSet', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    // promisify(execFile) convention: last arg is the (err, result) callback.
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );
  });

  it('passes the full base64 secret as one argv element (≥8KB survives — no security -i line split)', async () => {
    const big = 'x'.repeat(8192); // larger than the old `security -i` line buffer that truncated Atlassian tokens
    await keychainSet('atlassian:tokens', big);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/usr/bin/security');
    expect(args.slice(0, 7)).toEqual([
      'add-generic-password', '-U', '-s', 'com.xclaude.gateway', '-a', 'atlassian:tokens', '-w',
    ]);
    expect(args[7]).toBe(Buffer.from(big, 'utf8').toString('base64'));
    expect(args).toHaveLength(8);
  });
});
