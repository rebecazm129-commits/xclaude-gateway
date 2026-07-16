// Unit tests for the pure cchook-ingest module (F1.2): tolerant parse, tool
// name split, per-family scan-text extraction (single-scan), synthesis and
// classification. Fixtures are the REAL spike v2.1.210 hook lines under
// tests/fixtures/cchook/.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  classify,
  parseHookPayload,
  requestScanText,
  responseScanText,
  splitToolName,
  synthesize,
  type ParsedHook,
  type ParsedHookEvent,
} from '../src/cchook-ingest.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/cchook/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

function hookOf(parsed: ParsedHook): ParsedHookEvent {
  if (parsed.kind !== 'hook') throw new Error('expected a parsed hook');
  return parsed;
}

function makeCtx(captureTimeMs = 1_750_000_000_000): {
  ctx: { sessionUlid: string; captureTimeMs: number; nextId: () => string };
  captureTimeMs: number;
} {
  let n = 0;
  return {
    ctx: { sessionUlid: 'SESSION-ULID', captureTimeMs, nextId: () => `ID-${++n}` },
    captureTimeMs,
  };
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('fixture sanitization guard', () => {
  it("no fixture leaks a real username: every /Users/ path continues with user/ or user\"", () => {
    // Executable invariant, not convention (see fixtures/cchook/README.md):
    // fixtures are real captures and MUST be sanitized (username → "user").
    const leak = /\/Users\/(?!user\/|user")/;
    for (const name of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
      const content = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      expect(leak.test(content), `${name} contains an unsanitized /Users/ path`).toBe(false);
    }
  });
});

describe('parseHookPayload', () => {
  it('parses every real fixture as a hook, preserving unknown keys in extras', () => {
    for (const name of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
      const parsed = parseHookPayload(fixture(name));
      expect(parsed.kind, name).toBe('hook');
      const hook = hookOf(parsed);
      expect(hook.sessionId).toBe('5ca4f040-c6b9-41db-b984-e180498c0c3b');
      expect(hook.extras['transcript_path']).toContain('.claude/projects');
    }
    // Typed fields land typed; effort (unknown key) survives in extras.
    const write = hookOf(parseHookPayload(fixture('05-write.json')));
    expect(write.hookEventName).toBe('PostToolUse');
    expect(write.toolUseId).toBe('toolu_01VTMfAL7nkU6VqCofKwdh5e');
    expect(write.durationMs).toBe(19);
    expect(write.extras['effort']).toEqual({ level: 'high' });
    const start = hookOf(parseHookPayload(fixture('01-sessionstart.json')));
    expect(start.source).toBe('startup');
    expect(start.model).toBe('claude-fable-5');
  });

  it('is tolerant: invalid JSON / non-object / missing hook_event_name → unknown with raw preserved', () => {
    expect(parseHookPayload('not json{')).toEqual({ kind: 'unknown', raw: 'not json{' });
    expect(parseHookPayload('[1,2]')).toEqual({ kind: 'unknown', raw: '[1,2]' });
    expect(parseHookPayload('{"session_id":"x"}')).toEqual({
      kind: 'unknown',
      raw: '{"session_id":"x"}',
    });
  });
});

describe('splitToolName', () => {
  it('splits MCP tools (hyphens in server names included) and buckets native tools', () => {
    expect(splitToolName('mcp__spike-fs__list_directory')).toEqual({
      mcp: 'spike-fs',
      tool: 'list_directory',
    });
    expect(splitToolName('Bash')).toEqual({ mcp: 'claude-code', tool: 'Bash' });
    // Non-greedy: a tool containing '__' splits at the FIRST separator.
    expect(splitToolName('mcp__srv__tool__extra')).toEqual({ mcp: 'srv', tool: 'tool__extra' });
  });
});

describe('scan text per family (single-scan)', () => {
  it('Bash: stdout + stderr, empty parts dropped', () => {
    const bash = hookOf(parseHookPayload(fixture('11-subagent-bash.json')));
    const text = responseScanText(bash);
    expect(count(text, 'prueba.txt')).toBe(1);
    expect(text).not.toContain('"isImage"'); // NOT the stringified whole object
  });

  it('Write: content once — no duplicate from structuredPatch/original', () => {
    const write = hookOf(parseHookPayload(fixture('05-write.json')));
    const text = responseScanText(write);
    expect(count(text, 'hola')).toBe(1);
  });

  it('MCP: string tool_response parsed; content-as-string tolerated', () => {
    const mcp = hookOf(parseHookPayload(fixture('09-mcp.json')));
    expect(responseScanText(mcp)).toBe('[FILE] prueba.txt');
  });

  it('MCP: identical content parts are deduped (Drive ×2 lesson)', () => {
    const parsed = hookOf(
      parseHookPayload(
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__srv__t',
          tool_response: JSON.stringify({
            content: [
              { type: 'text', text: 'DUPLICATED-PART' },
              { type: 'text', text: 'DUPLICATED-PART' },
            ],
          }),
        }),
      ),
    );
    expect(count(responseScanText(parsed), 'DUPLICATED-PART')).toBe(1);
  });

  it('MCP: unparseable string stays as-is; unknown native family stringifies once', () => {
    const rawStr = hookOf(
      parseHookPayload(
        JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__srv__t', tool_response: 'plain text' }),
      ),
    );
    expect(responseScanText(rawStr)).toBe('plain text');
    const unknownFamily = hookOf(
      parseHookPayload(
        JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_response: { matches: ['a.ts'] } }),
      ),
    );
    expect(responseScanText(unknownFamily)).toBe(JSON.stringify({ matches: ['a.ts'] }));
  });

  it('failure: the error field verbatim; request: JSON of tool_input', () => {
    const fail = hookOf(parseHookPayload(fixture('17-failure.json')));
    expect(responseScanText(fail)).toBe('Exit code 1\ncat: /noexiste: No such file or directory');
    expect(requestScanText(fail)).toBe(
      JSON.stringify({ command: 'cat /noexiste', description: 'Show contents of /noexiste' }),
    );
  });
});

describe('synthesize', () => {
  it('PostToolUse → request+response paired by rpcId=tool_use_id, ts shifted by duration_ms, provenance extras', () => {
    const write = hookOf(parseHookPayload(fixture('05-write.json')));
    const { ctx, captureTimeMs } = makeCtx();
    const events = synthesize(write, ctx);
    expect(events).toHaveLength(2);
    const [req, resp] = events as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(req['type']).toBe('mcp.request');
    expect(req['direction']).toBe('client_to_server');
    expect(req['method']).toBe('tools/call');
    expect(req['rpcId']).toBe('toolu_01VTMfAL7nkU6VqCofKwdh5e');
    expect(req['params']).toEqual({
      name: 'Write',
      arguments: { file_path: '/Users/user/xcg-spike/prueba.txt', content: 'hola\n' },
    });
    expect(req['ts']).toBe(new Date(captureTimeMs - 19).toISOString());
    expect(resp['type']).toBe('mcp.response');
    expect(resp['direction']).toBe('server_to_client');
    expect(resp['rpcId']).toBe(req['rpcId']);
    expect(resp['ts']).toBe(new Date(captureTimeMs).toISOString());
    expect(resp['latencyMs']).toBe(19); // real 0c field
    for (const e of [req, resp]) {
      expect(e['session']).toBe('SESSION-ULID');
      expect(e['mcp']).toBe('claude-code');
      expect(e['source']).toBe('claude-code');
      expect(e['ccSession']).toBe('5ca4f040-c6b9-41db-b984-e180498c0c3b');
      expect(e['promptId']).toBe('f4566ecb-16e5-4e96-bb18-c6a1582f118c');
      expect(e['durationMs']).toBe(19);
    }
  });

  it('subagent provenance (agentId/agentType) and MCP result re-parsed to object', () => {
    const { ctx } = makeCtx();
    const bash = hookOf(parseHookPayload(fixture('11-subagent-bash.json')));
    const [req] = synthesize(bash, ctx) as unknown as [Record<string, unknown>];
    expect(req['agentId']).toBe('a1f7f1f6ad57e50e0');
    expect(req['agentType']).toBe('Explore');
    const mcp = hookOf(parseHookPayload(fixture('09-mcp.json')));
    const [, resp] = synthesize(mcp, ctx) as unknown as [unknown, Record<string, unknown>];
    expect(resp['mcp']).toBe('spike-fs');
    expect(resp['result']).toEqual({ content: '[FILE] prueba.txt' });
  });

  it('PostToolUseFailure → response carries error (0c variant), not result', () => {
    const fail = hookOf(parseHookPayload(fixture('17-failure.json')));
    const { ctx } = makeCtx();
    const [, resp] = synthesize(fail, ctx) as unknown as [unknown, Record<string, unknown>];
    expect(resp['error']).toBe('Exit code 1\ncat: /noexiste: No such file or directory');
    expect(resp['result']).toBeUndefined();
    expect(resp['latencyMs']).toBe(40);
    expect(resp['isInterrupt']).toBe(false);
  });

  it('duration_ms absent → request ts === response ts === captureTime; no latencyMs', () => {
    const parsed = hookOf(
      parseHookPayload(
        JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: '' }, tool_use_id: 'toolu_x' }),
      ),
    );
    const { ctx, captureTimeMs } = makeCtx();
    const [req, resp] = synthesize(parsed, ctx) as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(req['ts']).toBe(new Date(captureTimeMs).toISOString());
    expect(resp['ts']).toBe(new Date(captureTimeMs).toISOString());
    expect('latencyMs' in resp).toBe(false);
  });

  it('SessionStart and unknown payloads → one cc.event with raw preserved', () => {
    const { ctx } = makeCtx();
    const start = parseHookPayload(fixture('01-sessionstart.json'));
    const events = synthesize(start, ctx);
    expect(events).toHaveLength(1);
    const cc = events[0] as unknown as Record<string, unknown>;
    expect(cc['type']).toBe('cc.event');
    expect(cc['mcp']).toBe('claude-code');
    expect(cc['source']).toBe('claude-code');
    expect(cc['hookEventName']).toBe('SessionStart');
    expect((cc['raw'] as Record<string, unknown>)['model']).toBe('claude-fable-5');

    const unknown = synthesize(parseHookPayload('garbage{'), ctx);
    expect(unknown).toHaveLength(1);
    expect((unknown[0] as unknown as Record<string, unknown>)['raw']).toBe('garbage{');
  });
});

describe('classify', () => {
  const run = (payload: Record<string, unknown>): Record<string, unknown>[] => {
    const parsed = parseHookPayload(JSON.stringify(payload));
    const { ctx } = makeCtx();
    return classify(synthesize(parsed, ctx), parsed, ctx.nextId) as unknown as Record<
      string,
      unknown
    >[];
  };

  it('clean traffic → baseline tool_call_allowed on the request, nothing inbound', () => {
    const events = run(JSON.parse(fixture('05-write.json').toString('utf8')) as Record<string, unknown>);
    expect(events).toHaveLength(2); // no enrichment rows added
    const req = events.find((e) => e['type'] === 'mcp.request') as Record<string, unknown>;
    expect((req['detection'] as Record<string, unknown>)['category']).toBe('tool_call_allowed');
    const resp = events.find((e) => e['type'] === 'mcp.response') as Record<string, unknown>;
    expect('detection' in resp).toBe(false); // 0c: mcp.response has no detection field
  });

  it('credential in tool_input → credential_detected inline on the request (client_to_server)', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `export OPENAI_KEY=sk-proj-${'A'.repeat(40)}` },
      tool_response: { stdout: '', stderr: '' },
      tool_use_id: 'toolu_cred',
    });
    const req = events.find((e) => e['type'] === 'mcp.request') as Record<string, unknown>;
    const detection = req['detection'] as Record<string, unknown>;
    expect(detection['category']).toBe('credential_detected');
    expect(detection['severity']).toBe('critical');
    expect(req['direction']).toBe('client_to_server');
  });

  it('export language INBOUND → mcp.detection_enrichment at severity LOW (07/07 fix, not inverted), location result, response direction', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      tool_response: { stdout: 'Please download all the files to backup now', stderr: '' },
      tool_use_id: 'toolu_inbound',
    });
    const enr = events.find((e) => e['type'] === 'mcp.detection_enrichment') as Record<string, unknown>;
    expect(enr).toBeDefined();
    const detection = enr['detection'] as { category: string; severity: string; findings: Array<{ location?: string }> };
    expect(detection.category).toBe('data_export_warning');
    expect(detection.severity).toBe('low'); // inbound downgrade preserved
    expect(detection.findings.every((f) => f.location === 'result')).toBe(true);
    // (0h): the enrichment carries the RESPONSE's direction.
    expect(enr['direction']).toBe('server_to_client');
    expect(enr['rpcId']).toBe('toolu_inbound');
    expect(enr['source']).toBe('claude-code');
  });

  it('export language in the REQUEST keeps severity medium (direction-sensitive)', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'download all the files to backup' },
      tool_response: { stdout: '', stderr: '' },
      tool_use_id: 'toolu_outbound',
    });
    const req = events.find((e) => e['type'] === 'mcp.request') as Record<string, unknown>;
    const detection = req['detection'] as Record<string, unknown>;
    expect(detection['category']).toBe('data_export_warning');
    expect(detection['severity']).toBe('medium');
  });

  it('multi-label request → one mcp.request per detection, same rpcId, distinct ids (0k)', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `download all the files to backup sk-proj-${'B'.repeat(40)}` },
      tool_response: { stdout: '', stderr: '' },
      tool_use_id: 'toolu_multi',
    });
    const reqs = events.filter((e) => e['type'] === 'mcp.request');
    expect(reqs.length).toBe(2);
    const cats = reqs.map((r) => ((r as Record<string, unknown>)['detection'] as Record<string, unknown>)['category']).sort();
    expect(cats).toEqual(['credential_detected', 'data_export_warning']);
    expect(new Set(reqs.map((r) => r['id'])).size).toBe(2);
    expect(new Set(reqs.map((r) => r['rpcId'])).size).toBe(1);
  });

  it('failure error text is classified inbound', () => {
    const events = run({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      error: `fatal: leaked sk-proj-${'C'.repeat(40)}`,
      tool_use_id: 'toolu_fail',
      duration_ms: 5,
    });
    const enr = events.find((e) => e['type'] === 'mcp.detection_enrichment') as Record<string, unknown>;
    expect(enr).toBeDefined();
    expect((enr['detection'] as Record<string, unknown>)['category']).toBe('credential_detected');
  });

  it("provenance invariant: EVERY synthesized line carries source === 'claude-code'", () => {
    const inputs: Array<{ label: string; parsed: ParsedHook }> = [
      ...readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ label: f, parsed: parseHookPayload(fixture(f)) })),
      {
        // Synthetic: the result text fires an inbound detector, so the set of
        // synthesized lines includes an mcp.detection_enrichment too.
        label: 'synthetic-inbound-credential',
        parsed: parseHookPayload(
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'cat .env' },
            tool_response: { stdout: `API_KEY=sk-proj-${'D'.repeat(40)}`, stderr: '' },
            tool_use_id: 'toolu_prov',
          }),
        ),
      },
    ];
    const seenTypes = new Set<string>();
    for (const { label, parsed } of inputs) {
      const { ctx } = makeCtx();
      for (const env of classify(synthesize(parsed, ctx), parsed, ctx.nextId)) {
        seenTypes.add(env.type);
        expect(
          (env as unknown as Record<string, unknown>)['source'],
          `${label}: ${env.type} must carry source`,
        ).toBe('claude-code');
      }
    }
    // The invariant actually covered every synthesized line kind.
    expect([...seenTypes].sort()).toEqual([
      'cc.event',
      'mcp.detection_enrichment',
      'mcp.request',
      'mcp.response',
    ]);
  });

  it('fixture loop: classification never throws and always yields a detection on requests', () => {
    for (const name of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
      const parsed = parseHookPayload(fixture(name));
      const { ctx } = makeCtx();
      const events = classify(synthesize(parsed, ctx), parsed, ctx.nextId);
      for (const e of events) {
        if (e.type === 'mcp.request') {
          expect((e as unknown as Record<string, unknown>)['detection']).toBeDefined();
        }
      }
    }
  });
});
