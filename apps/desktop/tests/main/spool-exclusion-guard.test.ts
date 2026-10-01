// The spool exclusion survives the folder being recreated: same inode → no
// tmutil; a new inode → excluded again, once; gone → nothing until it returns.

import { describe, expect, it, vi } from 'vitest';

import { createSpoolExclusionGuard } from '../../src/main/spool-exclusion.js';

function guard(inodes: (number | null)[]) {
  let i = 0;
  const inodeOf = vi.fn(() => inodes[Math.min(i++, inodes.length - 1)] ?? null);
  const exclude = vi.fn(async () => 'excluded' as const);
  return { g: createSpoolExclusionGuard({ spoolDir: '/spool', exclude, inodeOf }), exclude };
}

describe('createSpoolExclusionGuard', () => {
  it('start excludes once and remembers the inode', async () => {
    const { g, exclude } = guard([100]);
    await expect(g.start()).resolves.toBe('excluded');
    expect(exclude).toHaveBeenCalledTimes(1);
  });

  it('same inode on later cycles: tmutil is not run again', async () => {
    const { g, exclude } = guard([100, 100, 100, 100]);
    await g.start();
    await g.check();
    await g.check();
    expect(exclude).toHaveBeenCalledTimes(1);
  });

  it('a different inode (folder recreated): excluded again, exactly once', async () => {
    // start → 100; check sees 200 → exclude → re-read 200; next check 200.
    const { g, exclude } = guard([100, 200, 200, 200]);
    await g.start();
    await g.check();
    await g.check();
    expect(exclude).toHaveBeenCalledTimes(2);
  });

  it('folder gone: nothing; when it comes back, excluded', async () => {
    const { g, exclude } = guard([100, null, null, 300, 300]);
    await g.start();
    await g.check(); // gone
    await g.check(); // still gone
    expect(exclude).toHaveBeenCalledTimes(1);
    await g.check(); // back with a new inode
    expect(exclude).toHaveBeenCalledTimes(2);
  });

  it('a failing exclusion is not retried every cycle for the same folder', async () => {
    let i = 0;
    const inodes = [100, 200, 200, 200];
    const exclude = vi.fn(async () => 'failed' as const);
    const g = createSpoolExclusionGuard({ spoolDir: '/spool', exclude, inodeOf: () => inodes[Math.min(i++, 3)]! });
    await g.start();
    await g.check();
    await g.check();
    expect(exclude).toHaveBeenCalledTimes(2);
  });
});
