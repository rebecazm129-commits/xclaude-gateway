import { describe, it, expect, vi } from 'vitest';

import { getSelfTestPayloads } from '@xcg/proxy/detection/selftest';
import type { SelfTestExample } from '@xcg/shared';

import { runSelfTest, type SelfTestConfig } from '../../src/main/selftest-handler.js';
import type { DetectionResult, WrapperHandle } from '../../src/main/selftest-runner.js';

// A detection map where every example fires exactly its expected category/severity.
function correctMap(payloads: readonly SelfTestExample[]): Map<number, DetectionResult> {
  return new Map(
    payloads.map((ex, i) => [i + 1, { category: ex.categoryKey, severity: ex.expectedSeverity }]),
  );
}

// Fresh mocks per test: a handle that records sent frames, a config, and
// deterministic runId/now. Tests wire their own launcher/reader on top.
function harness() {
  const payloads = getSelfTestPayloads();
  const send = vi.fn();
  const kill = vi.fn(() => Promise.resolve());
  const handle: WrapperHandle = {
    session: '01TESTSESSION',
    auditFile: '/tmp/fake.jsonl',
    send,
    kill,
  };
  const config: SelfTestConfig = {
    proxyBinPath: '/fake/xcg-proxy',
    npxPath: '/fake/npx',
    serverPackage: '@modelcontextprotocol/server-everything',
    discoveryTimeoutMs: 5000,
    readbackTimeoutMs: 3000,
  };
  let tick = 0;
  const now = (): string => `2026-05-24T00:00:0${tick++}.000Z`;
  const runId = (): string => 'run-1';
  return { payloads, send, kill, handle, config, now, runId };
}

describe('runSelfTest', () => {
  it('complete_pass when every example fires its expected detection', async () => {
    const h = harness();
    const launcher = vi.fn(() => Promise.resolve(h.handle));
    const reader = vi.fn(() => Promise.resolve(correctMap(h.payloads)));

    const report = await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    expect(report.outcome).toEqual({ kind: 'complete_pass' });
    expect(report.entries).toHaveLength(h.payloads.length);
    expect(report.entries.every((e) => e.pass)).toBe(true);
    expect(report.wrapperSession).toBe('01TESTSESSION');
    expect(report.auditFile).toBe('/tmp/fake.jsonl');
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('detection_mismatch when an entry fires the wrong category', async () => {
    const h = harness();
    const map = correctMap(h.payloads);
    map.set(1, { category: 'tool_call_allowed', severity: 'low' }); // rpcId 1 wrong
    const launcher = vi.fn(() => Promise.resolve(h.handle));
    const reader = vi.fn(() => Promise.resolve(map));

    const report = await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    expect(report.outcome).toEqual({ kind: 'detection_mismatch' });
    expect(report.entries[0]?.pass).toBe(false);
    expect(report.entries.slice(1).every((e) => e.pass)).toBe(true);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('timeout_partial when only some rpcIds were observed (all correct)', async () => {
    const h = harness();
    const partial = new Map([...correctMap(h.payloads)].slice(0, 3)); // ids 1,2,3
    const launcher = vi.fn(() => Promise.resolve(h.handle));
    const reader = vi.fn(() => Promise.resolve(partial));

    const report = await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    expect(report.outcome).toEqual({ kind: 'timeout_partial' });
    expect(report.entries.filter((e) => e.actual === null)).toHaveLength(2);
    expect(
      report.entries.filter((e) => e.actual !== null).every((e) => e.pass),
    ).toBe(true);
  });

  it('timeout_no_data when no detection was observed', async () => {
    const h = harness();
    const launcher = vi.fn(() => Promise.resolve(h.handle));
    const reader = vi.fn(() => Promise.resolve(new Map<number, DetectionResult>()));

    const report = await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    expect(report.outcome).toEqual({ kind: 'timeout_no_data' });
    expect(report.entries.every((e) => e.actual === null && !e.pass)).toBe(true);
  });

  it('spawn_failed when the launcher throws, without obtaining a handle', async () => {
    const h = harness();
    const launcher = vi.fn(() => Promise.reject(new Error('boom')));
    const reader = vi.fn(() => Promise.resolve(new Map<number, DetectionResult>()));

    const report = await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    expect(report.outcome.kind).toBe('spawn_failed');
    if (report.outcome.kind === 'spawn_failed') {
      expect(report.outcome.reason).toContain('boom');
    }
    expect(report.entries).toEqual([]);
    expect(report.wrapperSession).toBeNull();
    expect(report.auditFile).toBeNull();
    expect(h.kill).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it('reserves rpcId 0 for initialize and never includes it in expectedRpcIds', async () => {
    const h = harness();
    const launcher = vi.fn(() => Promise.resolve(h.handle));
    const reader = vi.fn(() => Promise.resolve(correctMap(h.payloads)));

    await runSelfTest(
      { launcher, reader, runId: h.runId, now: h.now, payloads: h.payloads },
      h.config,
    );

    // reader received auditFile + session + expected ids [1..5] (no 0) + timeout.
    expect(reader).toHaveBeenCalledTimes(1);
    const [auditFile, session, expectedRpcIds, timeoutMs] = reader.mock.calls[0]!;
    expect(auditFile).toBe('/tmp/fake.jsonl');
    expect(session).toBe('01TESTSESSION');
    expect(expectedRpcIds).toEqual([1, 2, 3, 4, 5]);
    expect(timeoutMs).toBe(h.config.readbackTimeoutMs);

    // send: initialize (id 0) + initialized (no id) + 5 tool calls (ids 1..5) = 7.
    expect(h.send).toHaveBeenCalledTimes(7);
    const frames = h.send.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(frames[0]).toMatchObject({ id: 0, method: 'initialize' });
    expect(frames[1]).toMatchObject({ method: 'notifications/initialized' });
    expect(frames[1]).not.toHaveProperty('id');
    expect(frames.slice(2).map((f) => f['id'])).toEqual([1, 2, 3, 4, 5]);
    expect(frames.slice(2).every((f) => f['method'] === 'tools/call')).toBe(true);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });
});
