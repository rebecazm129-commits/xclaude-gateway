// Claude Code MCP elicitation (Elicitation / ElicitationResult hooks).
//
// What the user typed (ElicitationResult.content) never reaches the spool nor
// the trail; of an Elicitation the trail keeps a strict whitelist — never a
// default, an enum, a description; the detection is protocol_tripwire /
// server_request, HIGH when a field's name or title asks for a secret; and
// the hook stays a silent exit 0 whatever it receives.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { CCHOOK_EVENTS, buildCchookHookEntry, mergeCchookHooks } from '@xcg/shared/config';

import { eventFromArgv, runCchook } from '../src/cchook.js';
import { ELICITATION_MESSAGE_MAX, namesASecret, readElicitation } from '../src/cchook-elicitation.js';
import { ELICITATION_PARSE_LIMIT, redactForSpool, stripUserValues } from '../src/cchook-spool.js';
import { ELICITATION_METHOD, classify, readSpool, synthesize } from '../src/cchook-ingest.js';
import { resetAuditKeyForTests } from '../src/detection/masking.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const TYPED_SECRET = 'hunter2-Correct-Horse-Battery';
const TYPED_EMAIL = 'invented.user@example.org';
const DEFAULT_VALUE = 'default-only-value-zzq';
const ENUM_VALUE = 'enum-choice-qqz';
const ONEOF_VALUE = 'oneof-const-xxw';
const DESCRIPTION = 'Paste the personal access token from your account settings';

const elicitation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'cc-sess-1',
  transcript_path: '/Users/x/.claude/projects/p/t.jsonl',
  cwd: '/Users/x/code/p',
  hook_event_name: 'Elicitation',
  mcp_server_name: 'spike-elicit',
  message: 'Please confirm your details',
  mode: 'form',
  requested_schema: {
    type: 'object',
    properties: {
      email: { type: 'string', title: 'Email', format: 'email', default: DEFAULT_VALUE },
      plan: { type: 'string', title: 'Plan', enum: [ENUM_VALUE, 'b'], enumNames: ['A', 'B'] },
      tier: { title: 'Tier', oneOf: [{ const: ONEOF_VALUE, title: 'X' }] },
      code: { type: 'string', pattern: '^[0-9]{6}$' },
    },
    required: ['email'],
  },
  ...over,
});

const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'cc-sess-1',
  cwd: '/Users/x/code/p',
  hook_event_name: 'ElicitationResult',
  mcp_server_name: 'spike-elicit',
  mode: 'form',
  action: 'accept',
  content: { email: TYPED_EMAIL, password: TYPED_SECRET, plan: ENUM_VALUE, email_default: DEFAULT_VALUE },
  ...over,
});

async function hook(input: string, argv: readonly string[] = []) {
  const spoolDir = mkdtempSync(join(tmpdir(), 'xcg-spool-'));
  const stdin = new PassThrough();
  const exits: number[] = [];
  const run = runCchook({ stdin, spoolDir, exit: (c) => void exits.push(c), auditKey: () => KEY, argv });
  stdin.end(input);
  await run;
  const files = readdirSync(spoolDir);
  return { exits, body: files.length === 1 ? readFileSync(join(spoolDir, files[0]!), 'utf8') : null };
}

function ingest(body: string): Record<string, unknown>[] {
  const { parsed, hookMasks } = readSpool(body);
  let n = 0;
  const ctx = { sessionUlid: 'S', captureTimeMs: 1_750_000_000_000, nextId: () => `I${++n}` };
  return classify(synthesize(parsed, ctx), parsed, ctx.nextId, hookMasks) as unknown as Record<string, unknown>[];
}

const detectionOf = (events: Record<string, unknown>[]) =>
  events[0]!['detection'] as { category: string; severity: string; findings: Record<string, unknown>[] };

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

describe('hook: ElicitationResult content never reaches the spool', () => {
  it('accept with invented values and a secret: none of them is in the spool file', async () => {
    const { exits, body } = await hook(JSON.stringify(result()));
    expect(exits).toEqual([0]);
    expect(body).not.toBeNull();
    for (const v of [TYPED_SECRET, TYPED_EMAIL, ENUM_VALUE, DEFAULT_VALUE]) expect(body).not.toContain(v);
    const inner = JSON.parse((JSON.parse(body!) as { payload: string }).payload) as Record<string, unknown>;
    expect(inner['content']).toBeUndefined();
    expect(inner['action']).toBe('accept');
    expect(inner['mcp_server_name']).toBe('spike-elicit');
  });

  it('a payload that looks like an ElicitationResult but does not parse → omitted, never the original', async () => {
    const broken = `{"hook_event_name":"ElicitationResult","content":{"password":"${TYPED_SECRET}"`;
    const { exits, body } = await hook(broken);
    expect(exits).toEqual([0]);
    expect(body).not.toContain(TYPED_SECRET);
    expect(JSON.parse(body!)).toMatchObject({ omitted: true, reason: 'redaction_failed' });
  });

  it('an ElicitationResult over the parse limit is omitted without parsing', async () => {
    const big = JSON.stringify(result({ content: { note: 'x'.repeat(ELICITATION_PARSE_LIMIT) } }));
    const { body } = await hook(big);
    expect(JSON.parse(body!)).toMatchObject({ omitted: true });
  });

  it('Elicitation is not parsed specially: the same text, only masked', () => {
    const raw = JSON.stringify(elicitation());
    expect(stripUserValues(raw)).toBe(raw);
  });

  it('text quoted inside a tool payload does not trigger the parse (escaped quotes)', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_input: { command: 'echo {"hook_event_name":"ElicitationResult"}' },
    });
    expect(stripUserValues(raw)).toBe(raw);
  });

  it('a nested key of another event is left unchanged', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_input: { hook_event_name: 'ElicitationResult', content: 'kept' },
    });
    expect(stripUserValues(raw)).toBe(raw);
  });
});

describe('hook: --event ElicitationResult strips without relying on the text (fail-closed)', () => {
  const FORCED = ['--event', 'ElicitationResult'];
  const innerOf = (body: string) =>
    JSON.parse((JSON.parse(body) as { payload: string }).payload) as Record<string, unknown>;

  it('a payload the text fallback would not recognize (unicode-escaped name) is still stripped', async () => {
    const disguised = JSON.stringify(result()).replace('"ElicitationResult"', '"Elicitation\\u0052esult"');
    expect(stripUserValues(disguised)).toBe(disguised); // the fallback alone misses it
    const { exits, body } = await hook(disguised, FORCED);
    expect(exits).toEqual([0]);
    expect(body).not.toContain(TYPED_SECRET);
    expect(innerOf(body!)['content']).toBeUndefined();
  });

  it('even with no hook_event_name at all, content is removed', async () => {
    const { body } = await hook(JSON.stringify({ action: 'accept', content: { password: TYPED_SECRET } }), FORCED);
    expect(body).not.toContain(TYPED_SECRET);
    expect(innerOf(body!)).toEqual({ action: 'accept' });
  });

  it('unparseable → omitted; over 1 MiB → omitted without parsing', async () => {
    const broken = await hook(`{"content":{"password":"${TYPED_SECRET}"`, FORCED);
    expect(broken.body).not.toContain(TYPED_SECRET);
    expect(JSON.parse(broken.body!)).toMatchObject({ omitted: true, reason: 'redaction_failed' });
    const big = await hook(JSON.stringify({ content: { note: 'x'.repeat(ELICITATION_PARSE_LIMIT) } }), FORCED);
    expect(JSON.parse(big.body!)).toMatchObject({ omitted: true });
  });

  it('--event Elicitation changes nothing: normal masking only', () => {
    const raw = JSON.stringify(elicitation());
    expect(stripUserValues(raw, 'Elicitation')).toBe(raw);
  });

  it('eventFromArgv reads the name after --event, and nothing else', () => {
    expect(eventFromArgv(['--event', 'ElicitationResult'])).toBe('ElicitationResult');
    expect(eventFromArgv([])).toBeUndefined();
    expect(eventFromArgv(['--event'])).toBeUndefined();
  });

  it('the hook entries for both elicitation events pass their name; the others stay as they were', () => {
    const hooks = mergeCchookHooks({}).settings['hooks'] as Record<string, { hooks: { args: string[] }[] }[]>;
    const script = (e: string) => hooks[e]![0]!.hooks[0]!.args[1];
    const base = 'exec "$HOME/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"';
    expect(script('ElicitationResult')).toBe(`${base} --event ElicitationResult`);
    expect(script('Elicitation')).toBe(`${base} --event Elicitation`);
    for (const e of ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd']) expect(script(e)).toBe(base);
    expect(buildCchookHookEntry().hooks[0]!.args[1]).toBe(base);
  });
});

describe('hook: text fallback for an entry without --event', () => {
  it('JSON with spaces around the colon is recognized and stripped', () => {
    const spaced = JSON.stringify(result()).replace('"hook_event_name":"ElicitationResult"', '"hook_event_name" :   "ElicitationResult"');
    expect(spaced).toContain('" :   "');
    const out = JSON.parse(stripUserValues(spaced)) as Record<string, unknown>;
    expect(out['content']).toBeUndefined();
    expect(out['action']).toBe('accept');
  });

  it('pretty-printed JSON with line breaks is recognized and stripped (through the hook too)', async () => {
    const pretty = JSON.stringify(result(), null, 2).replace('"hook_event_name": "ElicitationResult"', '"hook_event_name"\n  :\n  "ElicitationResult"');
    expect(pretty).toContain('\n');
    expect(JSON.parse(stripUserValues(pretty))['content']).toBeUndefined();
    const { body } = await hook(pretty);
    expect(body).not.toContain(TYPED_SECRET);
    expect(body).not.toContain(TYPED_EMAIL);
  });
});

describe('ingest: the trail keeps a strict whitelist', () => {
  it('Elicitation: server, mode, message and per field name/type/title/format/required only', () => {
    const events = ingest(redactForSpool(JSON.stringify(elicitation()), KEY));
    expect(events).toHaveLength(1);
    const req = events[0]!;
    expect(req['type']).toBe('mcp.request');
    expect(req['method']).toBe(ELICITATION_METHOD);
    expect(req['direction']).toBe('server_to_client');
    expect(req['mcp']).toBe('spike-elicit');
    expect(req['rpcId']).toBeNull();
    expect(req['params']).toEqual({
      mcp_server_name: 'spike-elicit',
      mode: 'form',
      message: 'Please confirm your details',
      fields: [
        { name: 'email', type: 'string', title: 'Email', format: 'email', required: true },
        { name: 'plan', type: 'string', title: 'Plan', required: false },
        { name: 'tier', title: 'Tier', required: false },
        { name: 'code', type: 'string', required: false },
      ],
    });
  });

  it('defaults, enums, enumNames, oneOf, const, pattern and descriptions are never stored', () => {
    const payload = elicitation({
      requested_schema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: DESCRIPTION, default: DEFAULT_VALUE },
          plan: { type: 'string', enum: [ENUM_VALUE], enumNames: ['Enum Name Zq'] },
          tier: { oneOf: [{ const: ONEOF_VALUE, title: 'X' }] },
          code: { type: 'string', pattern: '^zz-pattern$' },
        },
      },
    });
    const line = JSON.stringify(ingest(redactForSpool(JSON.stringify(payload), KEY)));
    for (const v of [DEFAULT_VALUE, ENUM_VALUE, 'Enum Name Zq', ONEOF_VALUE, '^zz-pattern$', DESCRIPTION]) {
      expect(line).not.toContain(v);
    }
    for (const k of ['"default"', '"enum"', '"enumNames"', '"oneOf"', '"const"', '"pattern"', '"description"', 'requested_schema', 'transcript_path']) {
      expect(line).not.toContain(k);
    }
  });

  it('a long message is truncated with message_truncated: true', () => {
    const events = ingest(redactForSpool(JSON.stringify(elicitation({ message: 'm'.repeat(2_000) })), KEY));
    const params = events[0]!['params'] as Record<string, unknown>;
    expect((params['message'] as string).length).toBe(ELICITATION_MESSAGE_MAX);
    expect(params['message_truncated']).toBe(true);
  });

  it('elicitation_id is kept when it arrives', () => {
    const events = ingest(redactForSpool(JSON.stringify(elicitation({ elicitation_id: 'el-42' })), KEY));
    expect((events[0]!['params'] as Record<string, unknown>)['elicitation_id']).toBe('el-42');
  });

  it('ElicitationResult: a cc.event with server, mode, elicitation_id and action — nothing else, no detection', () => {
    // A raw spool file (as an older hook left it) still carries content: the
    // ingest's whitelist is the second wall.
    const events = ingest(JSON.stringify(result({ elicitation_id: 'el-42' })));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev['type']).toBe('cc.event');
    expect(ev['hookEventName']).toBe('ElicitationResult');
    expect(ev['fields']).toEqual({ mcp_server_name: 'spike-elicit', mode: 'form', elicitation_id: 'el-42', action: 'accept' });
    expect(ev['detection']).toBeUndefined();
    const line = JSON.stringify(ev);
    for (const v of [TYPED_SECRET, TYPED_EMAIL, ENUM_VALUE, DEFAULT_VALUE, 'content']) expect(line).not.toContain(v);
  });

  it('an action outside accept/decline/cancel is not kept', () => {
    const ev = ingest(JSON.stringify(result({ action: 'completed', content: undefined })))[0]!;
    expect(ev['fields']).toEqual({ mcp_server_name: 'spike-elicit', mode: 'form' });
  });
});

describe('detection', () => {
  it('a form with a password field → protocol_tripwire / server_request, HIGH, location elicitation', () => {
    const payload = elicitation({
      requested_schema: { type: 'object', properties: { password: { type: 'string', title: 'Password' } } },
    });
    const det = detectionOf(ingest(redactForSpool(JSON.stringify(payload), KEY)));
    expect(det.category).toBe('protocol_tripwire');
    expect(det.severity).toBe('high');
    expect(det.findings).toEqual([{ type: 'server_request', location: 'elicitation', rule: 'secret_field' }]);
  });

  // Only the field's name or title raise it: the description is the server's
  // prose, and a warning ("do not give us your pin") reads like a request.
  it('a secret named only in the description stays MEDIUM, and the description is not stored', () => {
    const payload = elicitation({
      requested_schema: { type: 'object', properties: { value: { type: 'string', description: DESCRIPTION } } },
    });
    const events = ingest(redactForSpool(JSON.stringify(payload), KEY));
    expect(detectionOf(events)).toEqual({
      category: 'protocol_tripwire',
      severity: 'medium',
      findings: [{ type: 'server_request', location: 'elicitation' }],
    });
    expect(JSON.stringify(events)).not.toContain(DESCRIPTION);
  });

  it('a description that warns against giving a pin → MEDIUM', () => {
    const payload = elicitation({
      requested_schema: {
        type: 'object',
        properties: { phone: { type: 'string', title: 'Phone', description: 'do not give us your pin' } },
      },
    });
    const det = detectionOf(ingest(redactForSpool(JSON.stringify(payload), KEY)));
    expect(det.severity).toBe('medium');
    expect(det.findings).toEqual([{ type: 'server_request', location: 'elicitation' }]);
  });

  it('a field named "pin" → HIGH', () => {
    const payload = elicitation({
      requested_schema: { type: 'object', properties: { pin: { type: 'string' } } },
    });
    const det = detectionOf(ingest(redactForSpool(JSON.stringify(payload), KEY)));
    expect(det.severity).toBe('high');
    expect(det.findings).toEqual([{ type: 'server_request', location: 'elicitation', rule: 'secret_field' }]);
  });

  it('a field titled "API token" → HIGH', () => {
    const payload = elicitation({
      requested_schema: { type: 'object', properties: { value: { type: 'string', title: 'API token' } } },
    });
    const det = detectionOf(ingest(redactForSpool(JSON.stringify(payload), KEY)));
    expect(det.severity).toBe('high');
    expect(det.findings).toEqual([{ type: 'server_request', location: 'elicitation', rule: 'secret_field' }]);
  });

  it('a form without a secret field → medium', () => {
    const det = detectionOf(ingest(redactForSpool(JSON.stringify(elicitation()), KEY)));
    expect(det).toEqual({
      category: 'protocol_tripwire',
      severity: 'medium',
      findings: [{ type: 'server_request', location: 'elicitation' }],
    });
  });

  it('the secret words match whole tokens only', () => {
    for (const yes of ['password', 'apiKey', 'api_key', 'API key', 'private key', 'OTP code', 'pin', 'passphrase', 'client_secret', 'credentials', 'auth token'])
      expect(namesASecret(yes), yes).toBe(true);
    for (const no of ['author', 'spinner', 'keyboard', 'tokenizer', 'pinned', 'email', 'hotpot'])
      expect(namesASecret(no), no).toBe(false);
  });

  it('url mode: userinfo, http and punycode become flags; userinfo and fragment are never kept', () => {
    const payload = elicitation({
      mode: 'url',
      requested_schema: undefined,
      url: 'http://alice:pw-zz9@xn--pple-43d.com:8080/login?next=/home&token=tok-zz9#frag-zz9',
    });
    const events = ingest(redactForSpool(JSON.stringify(payload), KEY));
    const params = events[0]!['params'] as Record<string, unknown>;
    expect(params['url']).toEqual({
      scheme: 'http',
      host: 'xn--pple-43d.com',
      port: '8080',
      path: '/login',
      query: 'next=/home&token=[masked]',
      had_userinfo: true,
      had_fragment: true,
      non_https: true,
      punycode_host: true,
    });
    const line = JSON.stringify(events);
    for (const v of ['alice', 'pw-zz9', 'tok-zz9', 'frag-zz9']) expect(line).not.toContain(v);
    expect(detectionOf(events).severity).toBe('medium');
  });

  it('url mode with a unicode host is flagged as punycode too; a clean https URL has no flags set', () => {
    const uni = readElicitation({ mode: 'url', url: 'https://аpple.com/x' }).summary.url!;
    expect(uni.punycode_host).toBe(true);
    const clean = readElicitation({ mode: 'url', url: 'https://example.com/ok' }).summary.url!;
    expect(clean).toMatchObject({ had_userinfo: false, had_fragment: false, non_https: false, punycode_host: false });
  });
});

describe('the dialog never depends on the hook', () => {
  it('Elicitation and ElicitationResult: exit 0, nothing on stdout or stderr — even when stripping fails', async () => {
    for (const input of [
      JSON.stringify(elicitation()),
      JSON.stringify(result()),
      '{"hook_event_name":"ElicitationResult",',
    ]) {
      const { exits } = await hook(input);
      expect(exits).toEqual([0]);
    }
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('both events are registered, async like the rest', () => {
    expect(CCHOOK_EVENTS).toContain('Elicitation');
    expect(CCHOOK_EVENTS).toContain('ElicitationResult');
    expect(buildCchookHookEntry().hooks.every((h) => h.async === true)).toBe(true);
  });
});
