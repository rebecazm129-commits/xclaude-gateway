import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => (spawnMock as (...a: unknown[]) => unknown)(...args),
}));

import { runLoginProcess } from '../../src/main/login-runner.js';

// Fake child that exits 0 immediately so runLoginProcess resolves; we only
// assert the argv passed to spawn().
function fakeChildExitingOk() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => child.emit('exit', 0, null));
  return child;
}

describe('runLoginProcess (spawn argv)', () => {
  const base = { proxyBinPath: '/fake/xcg-proxy', url: 'https://example.com/mcp', name: 'gmail', timeoutMs: 1000 };

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChildExitingOk());
  });

  it('with scope → argv includes ["--scope", "<value>"]', async () => {
    await runLoginProcess({ ...base, scope: 'a b' });
    const [bin, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('/fake/xcg-proxy');
    expect(argv).toEqual(['login', '--url', base.url, '--name', 'gmail', '--scope', 'a b']);
  });

  it('without scope → argv identical to current (no flag)', async () => {
    await runLoginProcess({ ...base });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(argv).toEqual(['login', '--url', base.url, '--name', 'gmail']);
  });

  it('empty scope → no flag (retrocompat)', async () => {
    await runLoginProcess({ ...base, scope: '' });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(argv).toEqual(['login', '--url', base.url, '--name', 'gmail']);
  });
});
