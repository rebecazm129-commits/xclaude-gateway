// Invariant: a value the user typed (or a server's default for it) never
// reaches the bytes written to the audit trail. Each case goes the whole way
// the wrapper does — classify(line) → processFrame → EventSink → JsonlWriter —
// and the check is on the file's bytes, not on the in-memory event.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlWriter } from '../src/audit.js';
import { DetectionEngine } from '../src/detection/engine.js';
import { ACTIVE_DETECTORS } from '../src/detection/detectors/index.js';
import { EventSink } from '../src/events.js';
import { createFrameProcessor, type FrameProcessor } from '../src/frame-processor.js';
import { InflightTracker } from '../src/latency.js';
import { classify } from '../src/parser.js';
import type { Direction } from '../src/detection/types.js';

const SENTINEL = 'XCG_DO_NOT_STORE_12345';
const TS_NS = 1_000_000_000n;
const TS_MS = 1_700_000_000_000;

let dir: string;
let file: string;
let sink: EventSink;
let processFrame: FrameProcessor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xcg-elicitation-privacy-'));
  file = join(dir, 'session.jsonl');
  sink = new EventSink('test-mcp', [new JsonlWriter(file)], '01HXTESTSESSION', Buffer.alloc(32, 7));
  processFrame = createFrameProcessor({
    tracker: new InflightTracker(),
    engine: new DetectionEngine(ACTIVE_DETECTORS),
    mcp: 'test-mcp',
    session: '01HXTESTSESSION',
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Feed one wire line through the wrapper's path into the trail file. */
function feed(line: string, direction: Direction): void {
  for (const ev of processFrame(classify(line), direction, Buffer.byteLength(line) + 1, line, TS_NS, TS_MS)) {
    sink.emit(ev);
  }
}

/** Close the sink and return the trail: its raw bytes and its parsed lines. */
function trail(): { bytes: Buffer; lines: Record<string, unknown>[] } {
  sink.close();
  const bytes = readFileSync(file);
  const lines = bytes
    .toString('utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { bytes, lines };
}

function expectNoSentinel(bytes: Buffer): void {
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes.includes(SENTINEL)).toBe(false);
}

const rpc = (msg: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...msg });

/** A server's elicitation/create, then the client's answer. */
function elicit(answer: Record<string, unknown>, params?: Record<string, unknown>): void {
  feed(
    rpc({
      id: 'el-1',
      method: 'elicitation/create',
      params: params ?? { message: 'Sign in', requestedSchema: { type: 'object', properties: { user: { type: 'string' } } } },
    }),
    'server_to_client',
  );
  feed(rpc({ id: 'el-1', ...answer }), 'client_to_server');
}

function responseOf(lines: Record<string, unknown>[]): Record<string, unknown> {
  const r = lines.find((l) => l['type'] === 'mcp.response');
  if (r === undefined) throw new Error('no mcp.response in the trail');
  return r;
}

describe(`${SENTINEL} never reaches the trail`, () => {
  it('accept with nested content', () => {
    elicit({
      result: {
        action: 'accept',
        content: { account: { user: SENTINEL, tags: [SENTINEL, { deep: SENTINEL }] }, pin: SENTINEL },
      },
    });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(responseOf(lines)['result']).toEqual({ action: 'accept', content_omitted: true });
  });

  it.each(['decline', 'cancel'])('%s with unexpected content', (action) => {
    elicit({ result: { action, content: { user: SENTINEL } } });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(responseOf(lines)['result']).toEqual({ action, content_omitted: true });
  });

  it('unknown action', () => {
    elicit({ result: { action: SENTINEL, content: { user: SENTINEL } } });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(responseOf(lines)['result']).toEqual({ content_omitted: true, unparsed: true });
  });

  it('unknown mode', () => {
    elicit({ result: { action: 'accept', mode: SENTINEL, content: { user: SENTINEL } } });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(responseOf(lines)['result']).toEqual({ action: 'accept', content_omitted: true });
  });

  it('malformed line that starts with the sentinel', () => {
    const line = `${SENTINEL} {"jsonrpc":"2.0","id":"el-1","result":{"content":"${SENTINEL}"}}`;
    feed(line, 'client_to_server');
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'proxy.error',
      kind: 'parse_error',
      reason: 'invalid_json',
      unparsed: true,
      payload_omitted: true,
      byte_length: Buffer.byteLength(line, 'utf8'),
    });
    expect(lines[0]).not.toHaveProperty('frameSnippet');
  });

  it('error answer with the sentinel in message and data', () => {
    elicit({ error: { code: -32600, message: `user typed ${SENTINEL}`, data: { echo: SENTINEL } } });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    expect(responseOf(lines)['error']).toEqual({ code: -32600 });
  });

  it('server request with the sentinel as a default (and in enum, description, const)', () => {
    elicit(
      { result: { action: 'decline' } },
      {
        mode: 'form',
        message: 'Connect your account',
        requestedSchema: {
          type: 'object',
          properties: {
            api_token: { type: 'string', title: 'API token', description: SENTINEL, default: SENTINEL },
            region: { type: 'string', enum: [SENTINEL, 'eu'], enumNames: [SENTINEL, 'EU'], default: SENTINEL },
            plan: { const: SENTINEL, pattern: SENTINEL },
          },
          required: ['api_token'],
        },
        _meta: { note: SENTINEL },
      },
    );
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    const req = lines.find((l) => l['type'] === 'mcp.request' && l['method'] === 'elicitation/create');
    expect(req?.['params']).toEqual({
      mode: 'form',
      message: 'Connect your account',
      fields: [
        { name: 'api_token', type: 'string', title: 'API token', required: true },
        { name: 'region', type: 'string', required: false },
        { name: 'plan', required: false },
      ],
    });
  });

  it('message past 500 characters: the tail is not kept', () => {
    const message = `${'a'.repeat(500)}${SENTINEL}`;
    elicit({ result: { action: 'decline' } }, { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    const req = lines.find((l) => l['type'] === 'mcp.request' && l['method'] === 'elicitation/create');
    expect(req?.['params']).toEqual({ mode: 'form', message: 'a'.repeat(500), message_truncated: true });
  });

  // readUrl drops the userinfo and the fragment and masks credential-named
  // query values; that is where the sentinel goes. It KEEPS host, path and
  // other query values, as the hook does — not covered by this invariant.
  it('url mode: the sentinel in userinfo, fragment and credential-named query values', () => {
    const url =
      `https://${SENTINEL}:${SENTINEL}@auth.example.com/connect` +
      `?state=abc&token=${SENTINEL}&access_token=${SENTINEL}&x-amz-signature=${SENTINEL}#${SENTINEL}`;
    elicit(
      { result: { action: 'accept', mode: 'url' } },
      { mode: 'url', message: 'Open this link', url, elicitationId: SENTINEL, _meta: { n: SENTINEL } },
    );
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    const req = lines.find((l) => l['type'] === 'mcp.request' && l['method'] === 'elicitation/create');
    expect(req?.['params']).toEqual({
      mode: 'url',
      message: 'Open this link',
      url: {
        scheme: 'https',
        host: 'auth.example.com',
        path: '/connect',
        query: 'state=abc&token=[masked]&access_token=[masked]&x-amz-signature=[masked]',
        had_userinfo: true,
        had_fragment: true,
        non_https: false,
        punycode_host: false,
      },
    });
    expect(responseOf(lines)['result']).toEqual({ action: 'accept', mode: 'url', content_omitted: true });
  });

  it('url mode: an unparseable URL keeps only its flags', () => {
    elicit({ result: { action: 'cancel' } }, { mode: 'url', message: 'Open', url: `not a url ${SENTINEL}#x` });
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    const req = lines.find((l) => l['type'] === 'mcp.request' && l['method'] === 'elicitation/create');
    expect(req?.['params']).toEqual({
      mode: 'url',
      message: 'Open',
      url: { unparseable: true, had_userinfo: false, had_fragment: true },
    });
  });

  it('client request with inputResponses', () => {
    feed(
      rpc({
        id: 7,
        method: 'tools/call',
        params: {
          name: 'connect',
          arguments: { account: 'acme' },
          inputResponses: {
            'req-1': { action: 'accept', content: { password: SENTINEL } },
            'req-2': { action: 'accept', content: { otp: SENTINEL } },
          },
        },
      }),
      'client_to_server',
    );
    const { bytes, lines } = trail();
    expectNoSentinel(bytes);
    const req = lines.find((l) => l['type'] === 'mcp.request');
    expect(req?.['params']).toEqual({
      name: 'connect',
      arguments: { account: 'acme' },
      inputResponses: { omitted: true, count: 2 },
    });
  });
});

describe('elicitation/create request: detection still sees the raw params', () => {
  it('the recorded detection is what the engine yields on the unfiltered request', () => {
    const params = {
      message: 'Connect your account',
      requestedSchema: {
        type: 'object',
        properties: { secret: { type: 'string', title: 'Password', description: 'Your password', default: 'x' } },
      },
    };
    const expected = new DetectionEngine(ACTIVE_DETECTORS).detect({
      payload: params,
      mcp: 'test-mcp',
      method: 'elicitation/create',
      direction: 'server_to_client',
      sessionId: '01HXTESTSESSION',
    });
    feed(rpc({ id: 'el-2', method: 'elicitation/create', params }), 'server_to_client');
    const { lines } = trail();
    const recorded = lines.filter((l) => l['type'] === 'mcp.request').map((l) => l['detection']);
    expect(recorded).toEqual(expected);
    expect(recorded).toContainEqual(
      expect.objectContaining({ category: 'protocol_tripwire', findings: [expect.objectContaining({ type: 'server_request' })] }),
    );
  });
});
