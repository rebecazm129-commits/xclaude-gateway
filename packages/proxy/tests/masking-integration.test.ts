// Wrapper-path integration: a frame carrying a credential flows through
// createFrameProcessor → EventSink (with a key) → writer, and the PERSISTED
// line is masked. Also: fingerprint stability across events, a clean event
// byte-identical to the no-key path, and the truncation interaction (F1.3d
// adición 1 — the mask symbol survives to the masking point).

import { describe, expect, it } from 'vitest';

import { DetectionEngine } from '../src/detection/engine.js';
import { ACTIVE_DETECTORS } from '../src/detection/detectors/index.js';
import { createFrameProcessor } from '../src/frame-processor.js';
import { InflightTracker } from '../src/latency.js';
import { EventSink, readMaskSecrets } from '../src/events.js';
import { fingerprint, maskCredentials } from '../src/detection/masking.js';
import { classify, parseHookPayload, synthesize } from '../src/cchook-ingest.js';
import type { Envelope, Writer } from '../src/audit.js';
import type { ClassifiedFrame } from '../src/parser.js';

class CaptureWriter implements Writer {
  lines: string[] = [];
  write(e: Envelope): void {
    this.lines.push(JSON.stringify(e)); // the persisted form
  }
  close(): void {}
}

const KEY = Buffer.from('sixteenbytes-key-sixteenbytes-key', 'utf8');
const SK = `sk-proj-${'Z'.repeat(40)}`;

function processFrame() {
  return createFrameProcessor({
    tracker: new InflightTracker(),
    engine: new DetectionEngine(ACTIVE_DETECTORS),
    mcp: 'test-mcp',
    session: '01HXTESTSESSION',
  });
}

function drive(frame: ClassifiedFrame, key: Buffer | null): string[] {
  const w = new CaptureWriter();
  const sink = new EventSink('test-mcp', [w], '01HXTESTSESSION', key);
  for (const ev of processFrame()(frame, 'client_to_server', 100, '<line>', 1_000_000_000n, 1_700_000_000_000)) {
    sink.emit(ev);
  }
  return w.lines;
}

describe('credential masking — wrapper path', () => {
  it('a request with sk-… in params persists masked, never the secret', () => {
    const frame: ClassifiedFrame = {
      kind: 'request',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { key: SK } },
    };
    const lines = drive(frame, KEY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SK);
    expect(lines[0]).toContain(`${SK.slice(0, 10)}…[fp:`);
    // The detection finding is still there (type-only), and the line is valid JSON.
    const parsed = JSON.parse(lines[0]!) as { detection: { category: string } };
    expect(parsed.detection.category).toBe('credential_detected');
  });

  it('the fingerprint is stable across two events with the same key', () => {
    const mk = (id: number): ClassifiedFrame => ({
      kind: 'request',
      id,
      method: 'tools/call',
      params: { name: 'echo', arguments: { key: SK } },
    });
    const w = new CaptureWriter();
    const sink = new EventSink('test-mcp', [w], '01HXTESTSESSION', KEY);
    const pf = processFrame();
    for (const ev of pf(mk(1), 'client_to_server', 100, '<l>', 1n, 1)) sink.emit(ev);
    for (const ev of pf(mk(2), 'client_to_server', 100, '<l>', 2n, 2)) sink.emit(ev);
    const fp = (line: string): string => line.match(/\[fp:([0-9a-f]{16})\]/)![1]!;
    expect(fp(w.lines[0]!)).toBe(fp(w.lines[1]!));
  });

  it('an event WITHOUT a credential is byte-identical to the no-key path', () => {
    const frame: ClassifiedFrame = {
      kind: 'request',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'nothing secret here' } },
    };
    // Same id/ts machinery, so the only possible difference would be masking.
    // The EventSink adds a monotonic id + wall ts, so compare the stable
    // payload fields, not the whole line.
    const withKey = JSON.parse(drive(frame, KEY)[0]!) as Record<string, unknown>;
    const withoutKey = JSON.parse(drive(frame, null)[0]!) as Record<string, unknown>;
    expect(withKey['params']).toEqual(withoutKey['params']);
    expect(withKey['detection']).toEqual(withoutKey['detection']);
  });

  it('truncation + credential: a leaf under the 64KB cap keeps the secret, which is then masked', () => {
    // Secret well under the leaf cap → not truncated → present in the serialized
    // envelope → masked. (A leaf OVER the cap is replaced wholesale by the
    // truncation marker, dropping the secret entirely — also safe.)
    const frame: ClassifiedFrame = {
      kind: 'request',
      id: 9,
      method: 'tools/call',
      params: { name: 'echo', arguments: { note: `here: ${SK}`, filler: 'x'.repeat(100) } },
    };
    const lines = drive(frame, KEY);
    expect(lines[0]).not.toContain(SK);
    expect(lines[0]).toContain('[fp:');
  });

  it('CROSS-SOURCE: the same secret masks to the SAME fingerprint on the wire and via a hook', () => {
    const fpOf = (line: string): string => line.match(/\[fp:([0-9a-f]{16})\]/)![1]!;

    // Wire path (b.1): frame-processor → EventSink(KEY).
    const wireLine = drive(
      { kind: 'request', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { key: SK } } },
      KEY,
    )[0]!;

    // Hook path (b.2): cchook classify tags the envelope, the ingester serialize
    // step (replicated here with the SAME exported helpers) masks with KEY.
    const parsed = parseHookPayload(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: `export KEY=${SK}` },
        tool_response: { stdout: 'ok', stderr: '' },
        tool_use_id: 'toolu_x',
      }),
    );
    let n = 0;
    const envelopes = classify(
      synthesize(parsed, { sessionUlid: 'S', captureTimeMs: 1, nextId: () => `ID-${++n}` }),
      parsed,
      () => `ID-${++n}`,
    );
    const reqEnv = envelopes.find((e) => e.type === 'mcp.request')!;
    const hookLine = maskCredentials(JSON.stringify(reqEnv), readMaskSecrets(reqEnv)!, KEY);

    expect(wireLine).toContain('[fp:');
    expect(hookLine).toContain('[fp:');
    expect(fpOf(wireLine)).toBe(fpOf(hookLine)); // identical fingerprint → correlatable
    expect(fpOf(wireLine)).toBe(fingerprint(KEY, SK));
  });
});
