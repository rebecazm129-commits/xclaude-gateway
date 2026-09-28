// xcg-cchook masks every known credential format BEFORE writing the spool,
// with the trail's own code and salt; if masking fails, the original payload
// is never written.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { runCchook } from '../src/cchook.js';
import { REDACTION_VERSION, omittedSpoolBody, redactForSpool } from '../src/cchook-spool.js';
import { classify, readSpool, synthesize } from '../src/cchook-ingest.js';
import { credentialMatches } from '../src/detection/detectors/credential.js';
import { fingerprint, maskCredentials, resetAuditKeyForTests, resolveAuditKey } from '../src/detection/masking.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const SECRET = `sk-ant-api03-${'A'.repeat(40)}`;
const MASK = `[credential:anthropic_api_key fp:${fingerprint(KEY, SECRET)}]`;

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'cc-1',
    tool_name: 'Bash',
    tool_input: { command: 'cat .env' },
    tool_response: { stdout: `ANTHROPIC_API_KEY=${SECRET}\n`, stderr: '' },
    tool_use_id: 'toolu_1',
    ...over,
  });

async function hook(input: string, deps: Parameters<typeof runCchook>[0] = {}) {
  const spoolDir = mkdtempSync(join(tmpdir(), 'xcg-spool-'));
  const stdin = new PassThrough();
  const exits: number[] = [];
  const run = runCchook({ stdin, spoolDir, exit: (c) => void exits.push(c), auditKey: () => KEY, ...deps });
  stdin.end(input);
  await run;
  const files = readdirSync(spoolDir);
  return { exits, files, body: files.length === 1 ? readFileSync(join(spoolDir, files[0]!), 'utf8') : null };
}

let out: MockInstance<typeof process.stdout.write>;
let err: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  out = vi.spyOn(process.stdout, 'write');
  err = vi.spyOn(process.stderr, 'write');
  resetAuditKeyForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetAuditKeyForTests();
});

describe('the spool file is masked', () => {
  it('a known secret in tool_response is not in the spool; it carries the trail mask', async () => {
    const { exits, body } = await hook(payload());
    expect(exits).toEqual([0]);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('sk-ant-');
    const file = JSON.parse(body!) as { redaction_version: number; masked: unknown; payload: string };
    expect(file.redaction_version).toBe(REDACTION_VERSION);
    expect(file.masked).toEqual([{ type: 'anthropic_api_key', fp: fingerprint(KEY, SECRET) }]);
    expect(file.payload).toContain(MASK);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('the same mask the trail writes for the same secret and salt', () => {
    const trailLine = JSON.stringify({ type: 'mcp.response', result: { stdout: `key ${SECRET}` } });
    const trail = maskCredentials(trailLine, credentialMatches(trailLine), KEY);
    const spool = JSON.parse(redactForSpool(payload(), KEY)) as { payload: string };
    expect(trail).toContain(MASK);
    expect(spool.payload).toContain(MASK);
  });

  it('a secret inside a JSON string is found and replaced, and the payload stays the same JSON', () => {
    const raw = payload({ tool_input: { command: `curl -H "x-api-key: ${SECRET}" https://api.example.com` } });
    const spool = JSON.parse(redactForSpool(raw, KEY)) as { payload: string };
    const parsed = JSON.parse(spool.payload) as { tool_input: { command: string } };
    expect(parsed.tool_input.command).toBe(`curl -H "x-api-key: ${MASK}" https://api.example.com`);
  });

  it('a clean payload is kept as it was, with an empty mask list', () => {
    const raw = payload({ tool_response: { stdout: 'ok', stderr: '' } });
    const spool = JSON.parse(redactForSpool(raw, KEY)) as { masked: unknown[]; payload: string };
    expect(spool.masked).toEqual([]);
    expect(spool.payload).toBe(raw);
  });
});

describe('if masking fails, the original is never written', () => {
  it('a failing redaction writes only the omitted record — exit 0, silent', async () => {
    const { exits, body } = await hook(payload(), {
      redact: () => {
        throw new Error('forced');
      },
    });
    expect(exits).toEqual([0]);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('tool_response');
    const file = JSON.parse(body!) as Record<string, unknown>;
    expect(file).toMatchObject({ redaction_version: REDACTION_VERSION, omitted: true, reason: 'redaction_failed', bytes: Buffer.byteLength(payload()) });
    expect(typeof file['ts']).toBe('string');
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('a key that cannot be obtained is a failure too', async () => {
    const { body } = await hook(payload(), {
      auditKey: () => {
        throw new Error('no key');
      },
    });
    expect(JSON.parse(body!)).toMatchObject({ omitted: true, reason: 'redaction_failed' });
    expect(body).not.toContain(SECRET);
  });

  it('the omitted record reads back as a key-names-only cc.event', () => {
    const { parsed, hookMasks } = readSpool(omittedSpoolBody(1234, new Date(0)));
    expect(hookMasks.size).toBe(0);
    let n = 0;
    const ev = synthesize(parsed, { sessionUlid: 'S', captureTimeMs: 0, nextId: () => `I${++n}` })[0] as unknown as Record<string, unknown>;
    expect(ev).toMatchObject({ type: 'cc.event', payload_omitted: true, keys: ['redaction_version', 'omitted', 'reason', 'ts', 'bytes'] });
  });
});

describe('an unreadable salt still masks', () => {
  it('the ephemeral key masks, and nothing is printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xcg-salt-'));
    const notADir = join(dir, 'file');
    writeFileSync(notADir, 'x');
    const { body } = await hook(payload(), { auditKey: () => resolveAuditKey(join(notADir, 'base'), () => undefined) });
    expect(body).not.toContain(SECRET);
    expect(body).toMatch(/\[credential:anthropic_api_key fp:[0-9a-f]{16}\]/);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('the ingest reads the redacted spool', () => {
  const ingest = (body: string) => {
    const { parsed, hookMasks, redactionVersion } = readSpool(body);
    let n = 0;
    const ctx = { sessionUlid: 'S', captureTimeMs: 1_750_000_000_000, nextId: () => `I${++n}` };
    return { redactionVersion, events: classify(synthesize(parsed, ctx), parsed, ctx.nextId, hookMasks) as unknown as Record<string, unknown>[] };
  };

  it('a masked secret in tool_input raises credential_detected on the request', () => {
    const { redactionVersion, events } = ingest(redactForSpool(payload({ tool_input: { command: `echo ${SECRET}` }, tool_response: { stdout: 'ok', stderr: '' } }), KEY));
    expect(redactionVersion).toBe(1);
    const req = events.find((e) => e['type'] === 'mcp.request')!;
    expect(req['detection']).toEqual({
      category: 'credential_detected',
      severity: 'critical',
      findings: [{ type: 'anthropic_api_key', location: 'params' }],
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('a masked secret in tool_response raises the inbound enrichment', () => {
    const { events } = ingest(redactForSpool(payload(), KEY));
    const enr = events.find((e) => e['type'] === 'mcp.detection_enrichment' && (e['detection'] as Record<string, unknown>)['category'] === 'credential_detected');
    expect((enr!['detection'] as Record<string, unknown>)['findings']).toEqual([{ type: 'anthropic_api_key', location: 'result' }]);
  });

  it('a mask that was already in the text (the trail being read) is not a leak of this call', () => {
    const raw = payload({ tool_response: { stdout: `line with ${MASK}`, stderr: '' } });
    const { events } = ingest(redactForSpool(raw, KEY));
    const cats = events.map((e) => (e['detection'] as Record<string, unknown> | undefined)?.['category']).filter(Boolean);
    expect(cats).not.toContain('credential_detected');
  });

  it('a raw payload from an older hook still reads, and is classified as before', () => {
    const { redactionVersion, events } = ingest(payload({ tool_input: { command: `echo ${SECRET}` } }));
    expect(redactionVersion).toBeNull();
    const req = events.find((e) => e['type'] === 'mcp.request')!;
    expect((req['detection'] as Record<string, unknown>)['category']).toBe('credential_detected');
  });
});

describe('latency', () => {
  const big = (bytes: number): string => {
    const filler = 'lorem ipsum "path": "/Users/x/code/app/src/index.ts" 12345 {}[] ';
    const text = filler.repeat(Math.ceil(bytes / filler.length)).slice(0, bytes);
    return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: `${text.slice(0, bytes / 2)} ${SECRET} ${text.slice(bytes / 2)}` } });
  };

  for (const [label, bytes, budgetMs] of [['1 MB', 1_000_000, 500], ['32 MB', 32_000_000, 5_000]] as const) {
    it(`${label}: masks within ${budgetMs} ms`, () => {
      const input = big(bytes);
      const t = process.hrtime.bigint();
      const body = redactForSpool(input, KEY);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      expect(body).not.toContain(SECRET);
      expect(ms).toBeLessThan(budgetMs);
      console.info(`redactForSpool ${label}: ${ms.toFixed(1)} ms`);
    });
  }
});
