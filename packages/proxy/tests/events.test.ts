import { describe, expect, it } from 'vitest';

import type { Envelope, Writer } from '../src/audit.js';
import { createEnrichmentSink, EventSink, truncate } from '../src/events.js';

class CaptureWriter implements Writer {
  envelopes: Envelope[] = [];
  closed = false;
  write(e: Envelope): void {
    this.envelopes.push(e);
  }
  close(): void {
    this.closed = true;
  }
}

describe('truncate', () => {
  it('passes small strings through unchanged', () => {
    expect(truncate('hello', 64 * 1024)).toEqual({ value: 'hello', truncated: false });
  });

  it('replaces a string exceeding the threshold with a marker', () => {
    const big = 'a'.repeat(100);
    const r = truncate(big, 50);
    expect(r.truncated).toBe(true);
    expect(r.value).toBe('[truncated 100 bytes]');
  });

  it('reports utf-8 byte count for multibyte strings', () => {
    // 'é' = 2 bytes. 'éééé' = 8 bytes. Threshold 5 → truncated.
    const r = truncate('éééé', 5);
    expect(r.truncated).toBe(true);
    expect(r.value).toBe('[truncated 8 bytes]');
  });

  it('walks into arrays and marks parent truncated if any leaf was', () => {
    const r = truncate(['short', 'aaaaaaaaaaaaaaaaaaaa'], 10);
    expect(r.truncated).toBe(true);
    expect(r.value).toEqual(['short', '[truncated 20 bytes]']);
  });

  it('walks into objects and marks parent truncated if any leaf was', () => {
    const r = truncate({ small: 'ok', big: 'a'.repeat(50) }, 10);
    expect(r.truncated).toBe(true);
    expect(r.value).toEqual({ small: 'ok', big: '[truncated 50 bytes]' });
  });

  it('handles deeply nested structures', () => {
    const input = { a: { b: { c: [{ d: 'x'.repeat(100) }] } } };
    const r = truncate(input, 10);
    expect(r.truncated).toBe(true);
    expect(((r.value as { a: { b: { c: Array<{ d: string }> } } }).a.b.c[0]!).d).toBe(
      '[truncated 100 bytes]',
    );
  });

  it('passes non-string leaves through unchanged', () => {
    const r = truncate({ n: 42, b: true, nu: null, arr: [1, 2, 3] }, 10);
    expect(r.truncated).toBe(false);
    expect(r.value).toEqual({ n: 42, b: true, nu: null, arr: [1, 2, 3] });
  });

  it('returns truncated:false when nothing exceeded', () => {
    expect(truncate({ a: 'short', b: 'also short' }, 1000)).toEqual({
      value: { a: 'short', b: 'also short' },
      truncated: false,
    });
  });
});

describe('EventSink — composition', () => {
  it('writes the envelope to every writer in order', () => {
    const w1 = new CaptureWriter();
    const w2 = new CaptureWriter();
    const sink = new EventSink('x', [w1, w2]);
    sink.emit({ type: 'proxy.started', pid: 100, wrap: '/bin/cat', wrappedArgs: [] });
    expect(w1.envelopes).toHaveLength(1);
    expect(w2.envelopes).toHaveLength(1);
    expect(w1.envelopes[0]).toEqual(w2.envelopes[0]);
  });

  it('close() calls close on every writer', () => {
    const w1 = new CaptureWriter();
    const w2 = new CaptureWriter();
    const sink = new EventSink('x', [w1, w2]);
    sink.close();
    expect(w1.closed).toBe(true);
    expect(w2.closed).toBe(true);
  });

  it('emit with no writers does not throw (default empty array)', () => {
    const sink = new EventSink('x');
    expect(() =>
      sink.emit({ type: 'proxy.started', pid: 1, wrap: '/x', wrappedArgs: [] }),
    ).not.toThrow();
  });

  it('close with no writers does not throw', () => {
    expect(() => new EventSink('x').close()).not.toThrow();
  });
});

describe('EventSink — envelope shape', () => {
  it('produces envelope with v=1, ULID id, ISO ts, ULID session, mcp, type', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('my-mcp', [w]);
    sink.emit({ type: 'proxy.child_spawned', childPid: 42 });

    const e = w.envelopes[0]!;
    expect(e.v).toBe(1);
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(e.session).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(e.mcp).toBe('my-mcp');
    expect(e.type).toBe('proxy.child_spawned');
    expect((e as Envelope & { childPid: number }).childPid).toBe(42);
  });

  it('all events from one sink share the same session', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({ type: 'proxy.child_spawned', childPid: 1 });
    sink.emit({ type: 'proxy.child_spawned', childPid: 2 });
    expect(w.envelopes[0]!.session).toBe(w.envelopes[1]!.session);
  });

  it('each event gets a fresh id', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({ type: 'proxy.child_spawned', childPid: 1 });
    sink.emit({ type: 'proxy.child_spawned', childPid: 2 });
    expect(w.envelopes[0]!.id).not.toBe(w.envelopes[1]!.id);
  });

  // (era proxy.socket_dropped; repurposed al retirarse el SocketWriter,
  // 17/07/2026 — cubre el mismo passthrough de campos en eventos proxy.*)
  it('proxy.ner_dropped preserves reason and jobId in envelope', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({
      type: 'proxy.ner_dropped',
      reason: 'queue_full',
      jobId: 'job-1',
    });
    const e = w.envelopes[0]! as Envelope & { reason: string; jobId: string };
    expect(e.type).toBe('proxy.ner_dropped');
    expect(e.reason).toBe('queue_full');
    expect(e.jobId).toBe('job-1');
  });
});

describe('EventSink — truncation of mcp.* payloads', () => {
  it('truncates mcp.request params when a leaf exceeds 64 KB', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const huge = 'x'.repeat(70 * 1024);
    sink.emit({
      type: 'mcp.request',
      direction: 'client_to_server',
      rpcId: 1,
      method: 'tools/call',
      params: { content: huge },
      bytes: 80000,
      overheadUs: 0,
    });
    const e = w.envelopes[0]! as Envelope & {
      params: { content: string };
      truncated?: true;
      bytes: number;
    };
    expect(e.truncated).toBe(true);
    expect(e.params.content).toMatch(/^\[truncated \d+ bytes\]$/);
    expect(e.bytes).toBe(80000);
  });

  it('truncates mcp.response result and marks truncated', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const huge = 'x'.repeat(70 * 1024);
    sink.emit({
      type: 'mcp.response',
      direction: 'server_to_client',
      rpcId: 1,
      result: { content: huge },
      bytes: 80000,
      overheadUs: 0,
    });
    const e = w.envelopes[0]! as Envelope & {
      result: { content: string };
      truncated?: true;
    };
    expect(e.truncated).toBe(true);
    expect(e.result.content).toMatch(/^\[truncated \d+ bytes\]$/);
  });

  it('mcp.notification with small params is not truncated', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({
      type: 'mcp.notification',
      direction: 'client_to_server',
      method: 'notifications/initialized',
      params: { ok: true },
      bytes: 100,
      overheadUs: 0,
    });
    const e = w.envelopes[0]!;
    expect((e as { truncated?: true }).truncated).toBeUndefined();
    expect((e as Envelope & { params: unknown }).params).toEqual({ ok: true });
  });

  it('lifecycle events are NOT subjected to truncation', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const longArg = 'x'.repeat(70 * 1024);
    sink.emit({
      type: 'proxy.started',
      pid: 1,
      wrap: '/x',
      wrappedArgs: [longArg],
    });
    const e = w.envelopes[0]! as Envelope & {
      truncated?: true;
      wrappedArgs: string[];
    };
    expect(e.truncated).toBeUndefined();
    expect(e.wrappedArgs[0]).toBe(longArg);
  });

  // (era proxy.socket_dropped; repurposed al retirarse el SocketWriter,
  // 17/07/2026 — pinna que los eventos proxy.* con campos grandes NO pasan
  // por la truncación de payloads mcp.*)
  it('proxy.error is NOT subjected to truncation even with huge message', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const huge = 'x'.repeat(70 * 1024);
    sink.emit({
      type: 'proxy.error',
      kind: 'http_status_error',
      message: huge,
    });
    const e = w.envelopes[0]! as Envelope & { truncated?: true; message: string };
    expect(e.truncated).toBeUndefined();
    expect(e.message).toBe(huge);
  });

  it('truncates mcp.stderr text when it exceeds 64 KB', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const huge = 'x'.repeat(70 * 1024);
    sink.emit({
      type: 'mcp.stderr',
      text: huge,
      bytes: 70 * 1024,
      overheadUs: 0,
    });
    const e = w.envelopes[0]! as Envelope & { text: string; truncated?: true };
    expect(e.truncated).toBe(true);
    expect(e.text).toMatch(/^\[truncated \d+ bytes\]$/);
  });

  it('mcp.stderr with short text is not truncated', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({
      type: 'mcp.stderr',
      text: 'hola desde el child',
      bytes: 19,
      overheadUs: 0,
    });
    const e = w.envelopes[0]! as Envelope & { text: string; truncated?: true };
    expect(e.truncated).toBeUndefined();
    expect(e.text).toBe('hola desde el child');
  });

  it('mcp.detection_enrichment is NOT subjected to truncation', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    sink.emit({
      type: 'mcp.detection_enrichment',
      rpcId: 42,
      direction: 'client_to_server',
      detection: {
        category: 'pii_detected',
        severity: 'medium',
        findings: [{ type: 'email', location: 'params.email' }],
      },
      overheadUs: 12345,
    });
    const e = w.envelopes[0]! as Envelope & {
      truncated?: true;
      rpcId: number;
      direction: string;
      detection: { category: string };
      overheadUs: number;
    };
    expect(e.truncated).toBeUndefined();
    expect(e.type).toBe('mcp.detection_enrichment');
    expect(e.rpcId).toBe(42);
    expect(e.direction).toBe('client_to_server');
    expect(e.detection.category).toBe('pii_detected');
    expect(e.overheadUs).toBe(12345);
  });
});

describe('EventSink — mcp.response latencyMs', () => {
  it('preserves latencyMs in envelope when provided, omits the key when undefined', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);

    sink.emit({
      type: 'mcp.response',
      direction: 'server_to_client',
      rpcId: 1,
      result: { ok: true },
      bytes: 50,
      overheadUs: 0,
      latencyMs: 42,
    });
    sink.emit({
      type: 'mcp.response',
      direction: 'server_to_client',
      rpcId: 2,
      result: { ok: true },
      bytes: 50,
      overheadUs: 0,
      // latencyMs ausente: response huérfano (sin request matchado)
    });

    const withLatency = w.envelopes[0]! as Envelope & { latencyMs?: number };
    const orphan = w.envelopes[1]! as Envelope & { latencyMs?: number };

    expect(withLatency.latencyMs).toBe(42);
    expect('latencyMs' in orphan).toBe(false);
  });
});

describe('createEnrichmentSink — adapter', () => {
  it('emits mcp.detection_enrichment with exact shape; ignores enrichment.session', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const enrichmentSink = createEnrichmentSink(sink);
    enrichmentSink({
      rpcId: 7,
      session: 'session-from-async-detector-IGNORED',
      direction: 'server_to_client',
      detection: {
        category: 'credential_detected',
        severity: 'critical',
        findings: [{ type: 'api_key' }],
      },
      overheadUs: 99000,
    });
    const e = w.envelopes[0]! as Envelope & {
      rpcId: number;
      direction: string;
      detection: { category: string; severity: string };
      overheadUs: number;
    };
    expect(e.type).toBe('mcp.detection_enrichment');
    expect(e.rpcId).toBe(7);
    expect(e.direction).toBe('server_to_client');
    expect(e.detection.category).toBe('credential_detected');
    expect(e.detection.severity).toBe('critical');
    expect(e.overheadUs).toBe(99000);
    expect(e.session).not.toBe('session-from-async-detector-IGNORED');
    expect(e.session).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('preserves RpcId variants (string, null) without narrowing', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('x', [w]);
    const enrichmentSink = createEnrichmentSink(sink);

    enrichmentSink({
      rpcId: 'string-id',
      session: 's',
      direction: 'client_to_server',
      detection: { category: 'pii_detected', severity: 'low', findings: [] },
      overheadUs: 0,
    });
    enrichmentSink({
      rpcId: null,
      session: 's',
      direction: 'client_to_server',
      detection: { category: 'pii_detected', severity: 'low', findings: [] },
      overheadUs: 0,
    });

    expect((w.envelopes[0]! as Envelope & { rpcId: unknown }).rpcId).toBe('string-id');
    expect((w.envelopes[1]! as Envelope & { rpcId: unknown }).rpcId).toBe(null);
  });
});
