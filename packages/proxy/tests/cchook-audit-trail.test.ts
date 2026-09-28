// audit_trail_modification end to end through the Claude Code hook ingest:
// the detector runs on Claude Code's calls, with the hook's cwd, and never on
// a wrapped MCP server's (CLAUDE_CODE_DETECTORS vs ACTIVE_DETECTORS).

import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { xcgDataDir } from '@xcg/shared/config';

import { classify, parseHookPayload, synthesize } from '../src/cchook-ingest.js';
import { ACTIVE_DETECTORS, CLAUDE_CODE_DETECTORS, auditTrailModification } from '../src/detection/detectors/index.js';

function run(payload: Record<string, unknown>): Record<string, unknown>[] {
  const parsed = parseHookPayload(JSON.stringify(payload));
  let n = 0;
  const ctx = { sessionUlid: 'SESSION-ULID', captureTimeMs: 1_750_000_000_000, nextId: () => `ID-${++n}` };
  return classify(synthesize(parsed, ctx), parsed, ctx.nextId) as unknown as Record<string, unknown>[];
}
const categories = (events: Record<string, unknown>[]): unknown[] =>
  events
    .filter((e) => e['type'] === 'mcp.request')
    .map((e) => (e['detection'] as Record<string, unknown>)['category']);

describe('audit_trail_modification through cchook-ingest', () => {
  it('a Bash rm in the data folder, relative to the hook cwd, is flagged', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm wrappers/old.jsonl' },
      tool_response: { stdout: '', stderr: '' },
      tool_use_id: 'toolu_rm',
      cwd: xcgDataDir(homedir()),
    });
    expect(categories(events)).toEqual(['audit_trail_modification']);
    const req = events.find((e) => e['type'] === 'mcp.request')!;
    expect(req['detection']).toEqual({
      category: 'audit_trail_modification',
      severity: 'high',
      findings: [{ type: 'delete', location: 'Bash', rule: 'rm' }],
    });
  });

  it('the same command from another cwd is a plain tool call', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm wrappers/old.jsonl' },
      tool_response: { stdout: '', stderr: '' },
      tool_use_id: 'toolu_rm2',
      cwd: '/Users/user/code/app',
    });
    expect(categories(events)).toEqual(['tool_call_allowed']);
  });

  it('an MCP tool through Claude Code (mcp__server__tool) is out of scope', () => {
    const events = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__filesystem__Write',
      tool_input: { file_path: `${xcgDataDir(homedir())}/audit-salt`, content: 'x' },
      tool_response: {},
      tool_use_id: 'toolu_mcp',
    });
    expect(categories(events)).toEqual(['tool_call_allowed']);
  });

  it('only the Claude Code chain carries the detector', () => {
    expect(CLAUDE_CODE_DETECTORS).toContain(auditTrailModification);
    expect(ACTIVE_DETECTORS).not.toContain(auditTrailModification);
  });
});
