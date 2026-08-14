// Hook-integrity check: pure plan/parse/apply helpers + tmpdir integration of
// the fs orchestration (seed, vanished edge, in-app uninstall, restore,
// dismiss). The marker writer is injected (vi.fn) — its real shape and reader
// inertness are pinned in recovery-writer.test.ts.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOOK_STATE_FILENAME,
  applyDismiss,
  applyExpected,
  checkCchookIntegrity,
  dismissCchookNotice,
  parseHookState,
  planIntegrity,
  readPendingNotice,
  recordCchookExpected,
} from '../../src/main/cchook-integrity.js';
import type { CchookHookState } from '../../src/main/cchook-integrity.js';

const NOW = '2026-08-14T10:00:00.000Z';

describe('planIntegrity (pure)', () => {
  it('no state → seeds from the current registration, no notice', () => {
    expect(planIntegrity(null, true, NOW)).toEqual({
      kind: 'seed',
      next: { expected: true, pendingNotice: null },
    });
    expect(planIntegrity(null, false, NOW)).toEqual({
      kind: 'seed',
      next: { expected: false, pendingNotice: null },
    });
  });

  it('expected && !registered → vanished edge with a stamped notice', () => {
    expect(planIntegrity({ expected: true, pendingNotice: null }, false, NOW)).toEqual({
      kind: 'vanished',
      next: { expected: false, pendingNotice: { ts: NOW } },
    });
  });

  it('!expected && registered → restored, notice resolved', () => {
    expect(
      planIntegrity(
        { expected: false, pendingNotice: { ts: '2026-08-13T00:00:00.000Z' } },
        true,
        NOW,
      ),
    ).toEqual({ kind: 'restored', next: { expected: true, pendingNotice: null } });
  });

  it('steady states → none (zero writes on the common path)', () => {
    expect(planIntegrity({ expected: true, pendingNotice: null }, true, NOW)).toEqual({
      kind: 'none',
    });
    expect(planIntegrity({ expected: false, pendingNotice: null }, false, NOW)).toEqual({
      kind: 'none',
    });
    // A pending notice survives while the hook stays unregistered.
    expect(planIntegrity({ expected: false, pendingNotice: { ts: NOW } }, false, NOW)).toEqual({
      kind: 'none',
    });
  });
});

describe('parseHookState (tolerant)', () => {
  it('valid shapes round-trip', () => {
    expect(parseHookState({ expected: true, pendingNotice: null })).toEqual({
      expected: true,
      pendingNotice: null,
    });
    expect(parseHookState({ expected: false, pendingNotice: { ts: NOW } })).toEqual({
      expected: false,
      pendingNotice: { ts: NOW },
    });
  });

  it('absent pendingNotice tolerated as null', () => {
    expect(parseHookState({ expected: true })).toEqual({ expected: true, pendingNotice: null });
  });

  it('malformed → null (reseed; a corrupt file never invents a notice)', () => {
    expect(parseHookState(null)).toBeNull();
    expect(parseHookState([])).toBeNull();
    expect(parseHookState('expected')).toBeNull();
    expect(parseHookState({ expected: 'yes' })).toBeNull();
    expect(parseHookState({ expected: true, pendingNotice: { ts: 42 } })).toBeNull();
  });
});

describe('applyExpected / applyDismiss (pure)', () => {
  it('expected=true resolves a pending notice (Reinstall path)', () => {
    expect(applyExpected({ expected: false, pendingNotice: { ts: NOW } }, true)).toEqual({
      expected: true,
      pendingNotice: null,
    });
  });

  it('expected=false records the in-app intent without touching the notice', () => {
    expect(applyExpected({ expected: true, pendingNotice: null }, false)).toEqual({
      expected: false,
      pendingNotice: null,
    });
    expect(applyExpected(null, false)).toEqual({ expected: false, pendingNotice: null });
  });

  it('dismiss clears the notice, keeps expected; nothing to write otherwise', () => {
    expect(applyDismiss({ expected: false, pendingNotice: { ts: NOW } })).toEqual({
      expected: false,
      pendingNotice: null,
    });
    expect(applyDismiss({ expected: false, pendingNotice: null })).toBeNull();
    expect(applyDismiss(null)).toBeNull();
  });
});

describe('checkCchookIntegrity (tmpdir integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-integrity-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readState(): Promise<CchookHookState> {
    return JSON.parse(await readFile(join(dir, HOOK_STATE_FILENAME), 'utf8')) as CchookHookState;
  }

  it('absent state → seeds from the probe, no marker', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    expect(writeMarker).not.toHaveBeenCalled();
    expect(await readState()).toEqual({ expected: true, pendingNotice: null });
  });

  it('vanished edge → ONE marker with the settings path + pendingNotice; steady after', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    checkCchookIntegrity({
      stateDir: dir,
      registered: () => false,
      writeMarker,
      settingsPath: '/Users/user/.claude/settings.json',
      nowIso: () => NOW,
    });
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledWith('/Users/user/.claude/settings.json');
    expect(await readState()).toEqual({ expected: false, pendingNotice: { ts: NOW } });
    // Next pass over the same reality: no second marker, notice untouched.
    checkCchookIntegrity({
      stateDir: dir,
      registered: () => false,
      writeMarker,
      nowIso: () => '2026-08-14T11:00:00.000Z',
    });
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(await readState()).toEqual({ expected: false, pendingNotice: { ts: NOW } });
  });

  it('in-app uninstall (recordCchookExpected(false)) → no marker, no notice', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    recordCchookExpected(false, dir); // the cchook:uninstall handler's write
    checkCchookIntegrity({ stateDir: dir, registered: () => false, writeMarker });
    expect(writeMarker).not.toHaveBeenCalled();
    expect(await readState()).toEqual({ expected: false, pendingNotice: null });
    expect(readPendingNotice(dir)).toBeNull();
  });

  it('reinstall resolves: restored edge clears the notice', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    checkCchookIntegrity({ stateDir: dir, registered: () => false, writeMarker, nowIso: () => NOW });
    expect(readPendingNotice(dir)).toEqual({ ts: NOW });
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(await readState()).toEqual({ expected: true, pendingNotice: null });
    expect(readPendingNotice(dir)).toBeNull();
  });

  it('recordCchookExpected(true) resolves a pending notice (Reinstall handler path)', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    checkCchookIntegrity({ stateDir: dir, registered: () => false, writeMarker, nowIso: () => NOW });
    recordCchookExpected(true, dir); // cchook:install ok
    expect(await readState()).toEqual({ expected: true, pendingNotice: null });
  });

  it('dismissCchookNotice clears only the notice; repeated dismiss is a no-op', async () => {
    const writeMarker = vi.fn();
    checkCchookIntegrity({ stateDir: dir, registered: () => true, writeMarker });
    checkCchookIntegrity({ stateDir: dir, registered: () => false, writeMarker, nowIso: () => NOW });
    dismissCchookNotice(dir);
    expect(await readState()).toEqual({ expected: false, pendingNotice: null });
    dismissCchookNotice(dir); // nothing pending: no write, no throw
    expect(readPendingNotice(dir)).toBeNull();
  });

  it('corrupt state file → reseeds without a marker or notice', async () => {
    const writeMarker = vi.fn();
    await writeFile(join(dir, HOOK_STATE_FILENAME), '{not json', { mode: 0o600 });
    checkCchookIntegrity({ stateDir: dir, registered: () => false, writeMarker });
    expect(writeMarker).not.toHaveBeenCalled();
    expect(await readState()).toEqual({ expected: false, pendingNotice: null });
  });

  it('readPendingNotice on an absent state dir → null', () => {
    expect(readPendingNotice(join(dir, 'nope'))).toBeNull();
  });
});
