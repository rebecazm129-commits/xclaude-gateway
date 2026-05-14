import { describe, expect, it } from 'vitest';

import { DetectionEngine } from '../src/detection/engine.js';
import { createFrameProcessor } from '../src/frame-processor.js';
import { InflightTracker } from '../src/latency.js';
import type { ClassifiedFrame } from '../src/parser.js';

function makeDeps(): {
  tracker: InflightTracker;
  engine: DetectionEngine;
  mcp: string;
  session: string;
} {
  return {
    tracker: new InflightTracker(),
    engine: new DetectionEngine([]),
    mcp: 'test-mcp',
    session: '01HXTESTSESSION',
  };
}

const TS_NS = 1_000_000_000n;
const TS_MS = 1_700_000_000_000;
const BASELINE = {
  category: 'tool_call_allowed',
  severity: 'low',
  findings: [],
};

describe('createFrameProcessor', () => {
  it('attaches detection baseline to a tools/call request', () => {
    const processFrame = createFrameProcessor(makeDeps());
    const frame: ClassifiedFrame = {
      kind: 'request',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    };
    const events = processFrame(frame, 'client_to_server', 100, '<line>', TS_NS, TS_MS);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev?.type !== 'mcp.request') throw new Error('expected mcp.request');
    expect(ev.method).toBe('tools/call');
    expect(ev.detection).toEqual(BASELINE);
  });

  it('attaches detection baseline to an initialize request', () => {
    const processFrame = createFrameProcessor(makeDeps());
    const frame: ClassifiedFrame = {
      kind: 'request',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    };
    const events = processFrame(frame, 'client_to_server', 80, '<line>', TS_NS, TS_MS);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev?.type !== 'mcp.request') throw new Error('expected mcp.request');
    expect(ev.method).toBe('initialize');
    expect(ev.detection).toEqual(BASELINE);
  });

  it('does not attach detection to a response frame', () => {
    const deps = makeDeps();
    deps.tracker.trackRequest('client_to_server', 42, TS_MS - 100);
    const processFrame = createFrameProcessor(deps);
    const frame: ClassifiedFrame = {
      kind: 'response',
      id: 42,
      result: { content: [{ type: 'text', text: 'ok' }] },
    };
    const events = processFrame(frame, 'server_to_client', 50, '<line>', TS_NS, TS_MS);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('mcp.response');
    expect(ev).not.toHaveProperty('detection');
  });

  it('does not attach detection to a parse_error frame', () => {
    const processFrame = createFrameProcessor(makeDeps());
    const frame: ClassifiedFrame = {
      kind: 'parse_error',
      reason: 'invalid_json',
    };
    const events = processFrame(frame, 'client_to_server', 10, '{bad json', TS_NS, TS_MS);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('proxy.error');
    expect(ev).not.toHaveProperty('detection');
  });
});
