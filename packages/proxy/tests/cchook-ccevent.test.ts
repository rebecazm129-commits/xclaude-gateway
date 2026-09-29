// No Claude Code hook event reaches the trail without an explicit schema of
// what is kept. SessionStart/SessionEnd keep a whitelist of fields; anything
// else — a new hook event, a payload that does not parse — keeps only the
// NAMES of its top-level keys, never a value.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SESSION_EVENT_FIELDS, parseHookPayload, synthesize } from '../src/cchook-ingest.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cchook/01-sessionstart.json', import.meta.url));
const SECRET = `sk-ant-api03-${'Z'.repeat(40)}`;

function one(payload: string): Record<string, unknown> {
  let n = 0;
  const ctx = { sessionUlid: 'SESSION-ULID', captureTimeMs: 1_750_000_000_000, nextId: () => `ID-${++n}` };
  const events = synthesize(parseHookPayload(payload), ctx);
  expect(events).toHaveLength(1);
  return events[0] as unknown as Record<string, unknown>;
}

describe('cc.event — unknown events keep only key names', () => {
  it('an unknown hook event with a secret in "content": on disk only the keys', () => {
    const ev = one(
      JSON.stringify({ hook_event_name: 'SomethingNew', session_id: 'cc-1', content: { password: SECRET }, note: 'x' }),
    );
    expect(ev).toMatchObject({
      type: 'cc.event',
      source: 'claude-code',
      hookEventName: 'SomethingNew',
      ccSession: 'cc-1',
      payload_omitted: true,
      keys: ['hook_event_name', 'session_id', 'content', 'note'],
    });
    expect('raw' in ev).toBe(false);
    expect('fields' in ev).toBe(false);
    const line = JSON.stringify(ev);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('password');
  });

  it('an ElicitationResult keeps its whitelist (server, action), never what the user typed', () => {
    const ev = one(
      JSON.stringify({
        hook_event_name: 'ElicitationResult',
        session_id: 'cc-2',
        mcp_server_name: 'my-mcp-server',
        action: 'accept',
        content: { username: 'alice', token: SECRET },
      }),
    );
    expect(ev['fields']).toEqual({ mcp_server_name: 'my-mcp-server', action: 'accept' });
    expect('payload_omitted' in ev).toBe(false);
    expect(JSON.stringify(ev)).not.toMatch(/alice|sk-ant-/);
  });

  it('a payload that does not parse keeps nothing, not even the text', () => {
    const ev = one(`garbage{ ${SECRET}`);
    expect(ev).toMatchObject({ type: 'cc.event', payload_omitted: true, keys: [] });
    expect('hookEventName' in ev).toBe(false);
    expect(JSON.stringify(ev)).not.toContain('garbage');
  });

  it('JSON without hook_event_name: only its key names', () => {
    const ev = one(JSON.stringify({ session_id: 'x', secret: SECRET }));
    expect(ev).toMatchObject({ payload_omitted: true, keys: ['session_id', 'secret'] });
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });

  it('a PostToolUse with no tool_name is not a tool pair: key names only', () => {
    const ev = one(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'cc-3', tool_input: { command: SECRET } }));
    expect(ev['payload_omitted']).toBe(true);
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });
});

describe('cc.event — SessionStart and SessionEnd keep their whitelist', () => {
  it('the whitelist', () => {
    expect(SESSION_EVENT_FIELDS).toEqual({ SessionStart: ['source', 'model', 'cwd'], SessionEnd: ['reason', 'cwd'] });
  });

  it('SessionStart (real fixture): hookEventName, ccSession and the whitelisted fields; transcript_path dropped', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    const ev = one(readFileSync(FIXTURE, 'utf8'));
    expect(ev).toMatchObject({
      type: 'cc.event',
      hookEventName: 'SessionStart',
      ccSession: fixture['session_id'],
      fields: { source: fixture['source'], model: fixture['model'], cwd: fixture['cwd'] },
    });
    expect(Object.keys(ev['fields'] as object).sort()).toEqual(['cwd', 'model', 'source']);
    expect(JSON.stringify(ev)).not.toContain('transcript_path');
    expect('raw' in ev).toBe(false);
    expect('payload_omitted' in ev).toBe(false);
  });

  it('SessionEnd: reason and cwd; prompt_id, scratchpad_dir and anything else dropped', () => {
    const ev = one(
      JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'cc-4',
        reason: 'prompt_input_exit',
        cwd: '/Users/user/code/app',
        prompt_id: 'p-1',
        scratchpad_dir: '/tmp/x',
        transcript_path: '/Users/user/.claude/projects/x.jsonl',
        extra: SECRET,
      }),
    );
    expect(ev).toMatchObject({
      hookEventName: 'SessionEnd',
      ccSession: 'cc-4',
      fields: { reason: 'prompt_input_exit', cwd: '/Users/user/code/app' },
    });
    expect(Object.keys(ev['fields'] as object).sort()).toEqual(['cwd', 'reason']);
    expect(JSON.stringify(ev)).not.toMatch(/prompt_id|scratchpad|transcript|sk-ant-/);
  });

  it('a non-string value of a whitelisted field is not kept', () => {
    const ev = one(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: { nested: SECRET }, model: 42 }));
    expect(ev['fields']).toEqual({});
  });
});
