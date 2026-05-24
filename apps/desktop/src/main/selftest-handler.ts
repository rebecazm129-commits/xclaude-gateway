// Self-test orchestrator (C2.B.1.b) — the pure half of the Verify Detection
// feature. Composes the IO seams (launcher, reader) injected as dependencies,
// sequences the MCP handshake + one echo tool-call per registry example, reads
// detections back, and classifies the run into a SelfTestReport.
//
// No spawn, no filesystem, no electron here: every side effect is injected.
// Unit-tested with mocks (tests/main/selftest-handler.test.ts). The real wiring
// (C2.B.1.c) injects spawnWrapper / readDetectionsFromAudit / randomUUID / Date.

import type {
  Category,
  Severity,
  SelfTestExample,
  SelfTestEntryResult,
  SelfTestReport,
  SelfTestRunOutcome,
} from '@xcg/shared';
import { getSelfTestPayloads } from '@xcg/proxy/detection/selftest';

import {
  SELFTEST_WRAPPER_NAME,
  buildInitializeFrame,
  buildInitializedNotification,
  buildToolCallFrame,
  readDetectionsFromAudit,
  type SpawnWrapperOptions,
  type WrapperHandle,
} from './selftest-runner.js';

export interface SelfTestHandlerDeps {
  /** Spawns the wrapper and resolves the handle (real: spawnWrapper). */
  launcher: (opts: SpawnWrapperOptions) => Promise<WrapperHandle>;
  /** Reads detections back from the audit jsonl (real: readDetectionsFromAudit). */
  reader: typeof readDetectionsFromAudit;
  /** Generates the run id (real: () => randomUUID()). */
  runId: () => string;
  /** Returns an ISO timestamp (real: () => new Date().toISOString()). */
  now: () => string;
  /** Examples to run; defaults to the canonical registry. Injectable for tests. */
  payloads?: readonly SelfTestExample[];
}

export interface SelfTestConfig {
  readonly proxyBinPath: string;
  readonly npxPath: string;
  readonly serverPackage: string;
  readonly discoveryTimeoutMs: number;
  readonly readbackTimeoutMs: number;
}

// rpcId 0 is reserved for the initialize handshake; payloads take 1..N, so the
// initialize frame is never in expectedRpcIds and never counted as a result.
const INITIALIZE_RPC_ID = 0;

function classify(entries: readonly SelfTestEntryResult[]): SelfTestRunOutcome {
  const observed = entries.filter((e) => e.actual !== null);
  const mismatched = entries.filter((e) => e.actual !== null && !e.pass);
  if (mismatched.length > 0) return { kind: 'detection_mismatch' };
  if (observed.length === entries.length) return { kind: 'complete_pass' };
  if (observed.length === 0) return { kind: 'timeout_no_data' };
  return { kind: 'timeout_partial' };
}

/**
 * Run the self-test end to end. Pure orchestration over injected seams.
 * On launcher failure returns a spawn_failed report (the frozen outcome union
 * folds session-discovery failures into spawn_failed, since spawnWrapper throws
 * for spawn error, discovery timeout, and premature exit alike).
 */
export async function runSelfTest(
  deps: SelfTestHandlerDeps,
  config: SelfTestConfig,
): Promise<SelfTestReport> {
  const runId = deps.runId();
  const startedAt = deps.now();
  const payloads = deps.payloads ?? getSelfTestPayloads();

  const spawnOpts: SpawnWrapperOptions = {
    proxyBinPath: config.proxyBinPath,
    npxPath: config.npxPath,
    serverPackage: config.serverPackage,
    wrapperName: SELFTEST_WRAPPER_NAME,
    discoveryTimeoutMs: config.discoveryTimeoutMs,
  };

  let handle: WrapperHandle;
  try {
    handle = await deps.launcher(spawnOpts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      runId,
      startedAt,
      finishedAt: deps.now(),
      outcome: { kind: 'spawn_failed', reason },
      entries: [],
      wrapperSession: null,
      auditFile: null,
    };
  }

  try {
    handle.send(buildInitializeFrame(INITIALIZE_RPC_ID));
    handle.send(buildInitializedNotification());

    const expectedRpcIds: number[] = [];
    payloads.forEach((example, i) => {
      const rpcId = i + 1;
      expectedRpcIds.push(rpcId);
      handle.send(buildToolCallFrame(rpcId, example));
    });

    const detections = await deps.reader(
      handle.auditFile,
      handle.session,
      expectedRpcIds,
      config.readbackTimeoutMs,
    );

    const entries: SelfTestEntryResult[] = payloads.map((example, i) => {
      const rpcId = i + 1;
      const d = detections.get(rpcId) ?? null;
      const actual =
        d !== null
          ? { category: d.category as Category, severity: d.severity as Severity }
          : null;
      const pass =
        actual !== null &&
        actual.category === example.categoryKey &&
        actual.severity === example.expectedSeverity;
      return { example, actual, pass };
    });

    return {
      runId,
      startedAt,
      finishedAt: deps.now(),
      outcome: classify(entries),
      entries,
      wrapperSession: handle.session,
      auditFile: handle.auditFile,
    };
  } finally {
    await handle.kill();
  }
}
