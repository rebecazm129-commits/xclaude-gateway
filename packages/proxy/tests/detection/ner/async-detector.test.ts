import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { AsyncDetectorNer } from '../../../src/detection/ner/async-detector.js';
import type { DetectorInput } from '../../../src/detection/types.js';
import type { WorkerJobResponse } from '../../../src/detection/ner/worker-pure.js';

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  ee.send = vi.fn();
  ee.kill = vi.fn();
  return ee;
}

function input(paramsJson: string): DetectorInput {
  return {
    paramsJson,
    toolName: undefined,
    envelope: {
      payload: undefined,
      mcp: 'test-mcp',
      method: 'tools/call',
      direction: 'client_to_server',
      sessionId: 'sess-1',
    },
  };
}

function setup() {
  const child = fakeChild();
  const enriched: unknown[] = [];
  const drops: Array<{ reason: string; rpcId: unknown }> = [];
  const deaths: Array<{ cause: string; pendingDropped: number }> = [];
  const det = new AsyncDetectorNer({
    workerScript: 'unused',
    enrichmentSink: (e) => enriched.push(e),
    onDrop: (reason, _jobId, rpcId) => drops.push({ reason, rpcId }),
    onWorkerDied: (cause, pendingDropped) => deaths.push({ cause, pendingDropped }),
    forkImpl: () => child as unknown as never,
  });
  return { child, enriched, drops, deaths, det };
}

function emit(child: EventEmitter, msg: WorkerJobResponse) {
  child.emit('message', msg);
}

describe('AsyncDetectorNer', () => {
  it('queues before ready and drains on ready', () => {
    const { child, det } = setup();
    det.enqueue(input('{"a":1}'), 1);
    expect(child.send).not.toHaveBeenCalled();
    emit(child, { kind: 'ready' });
    expect(child.send).toHaveBeenCalledTimes(1);
  });

  it('invokes the sink on result with a measured overheadUs', () => {
    const { child, enriched, det } = setup();
    emit(child, { kind: 'ready' });
    det.enqueue(input('{"a":1}'), 7);
    emit(child, {
      kind: 'result',
      jobId: 'j',
      rpcId: 7,
      session: 'sess-1',
      direction: 'client_to_server',
      detection: { category: 'pii_detected', severity: 'low', findings: [] },
    });
    expect(enriched).toHaveLength(1);
    const e = enriched[0] as { rpcId: number; overheadUs: number };
    expect(e.rpcId).toBe(7);
    expect(typeof e.overheadUs).toBe('number');
    expect(e.overheadUs).toBeGreaterThanOrEqual(0);
  });

  it('does not invoke the sink on skip', () => {
    const { child, enriched, det } = setup();
    emit(child, { kind: 'ready' });
    det.enqueue(input('{"a":1}'), 1);
    emit(child, { kind: 'skip', jobId: 'j' });
    expect(enriched).toHaveLength(0);
  });

  it('does not invoke the sink on job-level error', () => {
    const { child, enriched, det } = setup();
    emit(child, { kind: 'ready' });
    det.enqueue(input('{"a":1}'), 1);
    emit(child, { kind: 'error', jobId: 'j', message: 'boom' });
    expect(enriched).toHaveLength(0);
  });

  it('processes one in-flight at a time', () => {
    const { child, det } = setup();
    emit(child, { kind: 'ready' });
    det.enqueue(input('{"a":1}'), 1);
    det.enqueue(input('{"b":2}'), 2);
    expect(child.send).toHaveBeenCalledTimes(1);
    emit(child, {
      kind: 'result',
      jobId: 'j1',
      rpcId: 1,
      session: 'sess-1',
      direction: 'client_to_server',
      detection: { category: 'pii_detected', severity: 'low', findings: [] },
    });
    expect(child.send).toHaveBeenCalledTimes(2);
  });

  it('drops newest with telemetry when the queue is full', () => {
    const { det, drops } = setup();
    // Sin 'ready': nada se despacha, todo se acumula. 256 entran, el 257 cae.
    for (let i = 0; i < 256; i++) det.enqueue(input('{"x":1}'), i);
    expect(drops).toHaveLength(0);
    det.enqueue(input('{"x":1}'), 999);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({ reason: 'queue_full', rpcId: 999 });
  });

  it('is a silent no-op after the worker dies', () => {
    const { child, det, drops, deaths } = setup();
    emit(child, { kind: 'ready' });
    child.emit('exit', 1, null);
    det.enqueue(input('{"a":1}'), 1);
    expect(child.send).not.toHaveBeenCalled();
    expect(drops).toHaveLength(0);
    expect(deaths).toEqual([{ cause: 'exit', pendingDropped: 0 }]);
  });

  it('drains the queue with worker_dead on worker death', () => {
    const { child, det, drops, deaths } = setup();
    // Sin 'ready': los jobs se acumulan en la cola sin despacharse.
    det.enqueue(input('{"a":1}'), 1);
    det.enqueue(input('{"b":2}'), 2);
    child.emit('exit', 1, null);
    expect(drops).toEqual([
      { reason: 'worker_dead', rpcId: 1 },
      { reason: 'worker_dead', rpcId: 2 },
    ]);
    expect(deaths).toEqual([{ cause: 'exit', pendingDropped: 2 }]);
  });

  it('includes the in-flight job in the drain on worker death', () => {
    const { child, det, drops, deaths } = setup();
    emit(child, { kind: 'ready' });
    det.enqueue(input('{"a":1}'), 1);
    // Job 1 esta in-flight (despachado, sin respuesta). Job 2 en cola.
    det.enqueue(input('{"b":2}'), 2);
    child.emit('exit', 1, null);
    expect(drops).toEqual([
      { reason: 'worker_dead', rpcId: 1 },
      { reason: 'worker_dead', rpcId: 2 },
    ]);
    expect(deaths).toEqual([{ cause: 'exit', pendingDropped: 2 }]);
  });

  it('reports cause error when the worker errors', () => {
    const { child, det, deaths } = setup();
    child.emit('error', new Error('fork failed'));
    expect(deaths).toEqual([{ cause: 'error', pendingDropped: 0 }]);
  });

  it('invokes onWorkerDied only once on double death (exit then error)', () => {
    const { child, det, deaths } = setup();
    child.emit('exit', 1, null);
    child.emit('error', new Error('late error'));
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toEqual({ cause: 'exit', pendingDropped: 0 });
  });

  it('terminate sends SIGTERM and resolves on worker exit', async () => {
    const { child, det } = setup();
    const p = det.terminate(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, null);
    await expect(p).resolves.toBeUndefined();
  });

  it('terminate escalates to SIGKILL on timeout', async () => {
    vi.useFakeTimers();
    const { child, det } = setup();
    const p = det.terminate(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('terminate resolves immediately when worker already dead', async () => {
    const { child, det } = setup();
    child.emit('exit', 1, null);
    child.kill.mockClear();
    await expect(det.terminate(1000)).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
