// @vitest-environment jsdom
// F2-04 step 1: the polled config status hook. Covers the poll picking up a
// changed result, the dedupe contract (unchanged result → SAME reference, plus
// `previous` carrying the prior distinct snapshot for the step-2 diff), a
// rejecting tick preserving the last good state, and the manual refresh().
// Fake timers drive the 10s interval.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { usePolledConfigStatus } from '../../src/renderer/hooks/usePolledConfigStatus.js';
import type { StatusResult } from '@xcg/shared/config';

function status(alreadyWrapped: number): StatusResult {
  return {
    ok: true,
    configPresent: true,
    configPath: '/tmp/claude_desktop_config.json',
    entries: [],
    summary: { wrappable: 0, alreadyWrapped, skippedOther: 0 },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Flush the immediate on-mount tick (async IPC stub resolves on a microtask).
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('usePolledConfigStatus', () => {
  it('picks up a changed result on the next tick', async () => {
    vi.useFakeTimers();
    const configStatus = vi.fn(async () => status(1));
    vi.stubGlobal('xcg', { configStatus });
    const { result } = renderHook(() => usePolledConfigStatus());
    await flush();
    expect(result.current.status).toEqual(status(1));

    configStatus.mockImplementation(async () => status(2));
    await advance(10000);
    expect(result.current.status).toEqual(status(2));
    // previous carries the prior distinct snapshot (step-2 diff input).
    expect(result.current.previous).toEqual(status(1));
  });

  it('dedupe: an unchanged result keeps the SAME reference (fresh object each tick)', async () => {
    vi.useFakeTimers();
    // New object every call, deep-equal content: dedupe must be structural.
    const configStatus = vi.fn(async () => status(1));
    vi.stubGlobal('xcg', { configStatus });
    const { result } = renderHook(() => usePolledConfigStatus());
    await flush();
    const first = result.current.status;
    expect(first).not.toBeNull();

    await advance(10000);
    await advance(10000);
    expect(configStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.current.status).toBe(first);
    expect(result.current.previous).toBeNull();
  });

  it('a rejecting tick logs and keeps the last good state', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const configStatus = vi.fn(async () => status(1));
    vi.stubGlobal('xcg', { configStatus });
    const { result } = renderHook(() => usePolledConfigStatus());
    await flush();
    const first = result.current.status;

    configStatus.mockImplementation(async () => {
      throw new Error('ipc down');
    });
    await advance(10000);
    expect(result.current.status).toBe(first);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('manual refresh() refetches outside the interval', async () => {
    vi.useFakeTimers();
    const configStatus = vi.fn(async () => status(1));
    vi.stubGlobal('xcg', { configStatus });
    const { result } = renderHook(() => usePolledConfigStatus());
    await flush();

    configStatus.mockImplementation(async () => status(7));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toEqual(status(7));
    expect(result.current.previous).toEqual(status(1));
  });
});
