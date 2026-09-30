// proxy.oauth_authorized as an MCP changes row: the mapping, which logins are
// rows, and how a login's proxy.oauth_reference note is attached.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fromOAuthLine, readConnectorChanges } from '../../src/main/connector-changes.js';

function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, id: 'evt-1', ts: '2026-09-30T08:00:00.000Z', session: 'S1', mcp: 'github',
    type: 'proxy.oauth_authorized',
    authorization_server: 'https://github.com/login/oauth',
    authorization_server_source: 'protected_resource_metadata',
    resource: 'https://api.githubcopilot.com/mcp/',
    requested_scopes: ['read:org', 'repo'],
    effective_granted_scopes: ['read:org', 'repo'],
    scope_source: 'token_response',
    first_login: false,
    previous_login_at: '2026-09-28T16:02:00.000Z',
    changes: [],
    findings: [],
    ...over,
  };
}

describe('fromOAuthLine', () => {
  it('a login identical to the previous one is not a row', () => {
    expect(fromOAuthLine(line())).toBeNull();
  });

  it('authorization server changed: HIGH, before → now, host as evidence', () => {
    const v = fromOAuthLine(
      line({
        authorization_server: 'https://login.other.example/',
        findings: [{ rule_id: 'authorization_server_changed', rule_version: 1, severity: 'high', before: 'https://github.com/login/oauth', after: 'https://login.other.example/' }],
      }),
    )!;
    expect(v.section).toBe('authorization');
    expect(v.findings).toEqual([
      { rule_id: 'authorization_server_changed', rule_version: 1, severity: 'high', evidence: { target: 'login.other.example' } },
    ]);
    expect(v.authorization?.authorization_server).toEqual({ before: 'https://github.com/login/oauth', now: 'https://login.other.example/' });
    expect(v.authorization?.previous_login_at).toBe('2026-09-28T16:02:00.000Z');
  });

  it('scopes expanded and reduced: before reconstructed from now − added + removed', () => {
    const v = fromOAuthLine(
      line({
        effective_granted_scopes: ['admin:org', 'read:org'],
        changes: [{ field: 'scopes_reduced', removed: ['repo'] }],
        findings: [{ rule_id: 'scopes_expanded', rule_version: 1, severity: 'medium', added: ['admin:org'] }],
      }),
    )!;
    expect(v.authorization?.scopes).toEqual({
      before: ['read:org', 'repo'],
      now: ['admin:org', 'read:org'],
      added: ['admin:org'],
      removed: ['repo'],
    });
    expect(v.changes).toEqual([
      { kind: 'item_added', target: 'admin:org' },
      { kind: 'item_removed', target: 'repo' },
    ]);
    expect(v.findings.map((f) => [f.rule_id, f.severity, f.evidence.count])).toEqual([['scopes_expanded', 'medium', 1]]);
  });

  it('resource changed: a fact, no finding', () => {
    const v = fromOAuthLine(
      line({ resource: 'https://api.githubcopilot.com/v2/', changes: [{ field: 'resource', before: 'https://api.githubcopilot.com/mcp/', after: 'https://api.githubcopilot.com/v2/' }] }),
    )!;
    expect(v.findings).toEqual([]);
    expect(v.authorization?.resource).toEqual({ before: 'https://api.githubcopilot.com/mcp/', now: 'https://api.githubcopilot.com/v2/', changed: true });
  });

  it('first login: a row, nothing before', () => {
    const v = fromOAuthLine(line({ first_login: true, previous_login_at: null }), 'initialized')!;
    expect(v.findings).toEqual([]);
    expect(v.authorization).toMatchObject({
      first_login: true,
      previous_login_at: null,
      reference_note: 'initialized',
      authorization_server: { before: null },
      scopes: { before: null },
      resource: { before: null, changed: false },
    });
  });
});

describe('readConnectorChanges — authorization rows', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-cc-oauth-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('attaches the reference note written before the login (reseeded) and after it (write_failed)', async () => {
    const d = join(dir, 'notes');
    await mkdir(d, { recursive: true });
    const ref = (session: string, event: string, reason: string) =>
      JSON.stringify({ v: 1, id: `r-${session}-${event}`, ts: '2026-09-30T08:00:00.000Z', session, mcp: 'github', type: 'proxy.oauth_reference', event, reason });
    await writeFile(
      join(d, 'a.jsonl'),
      [ref('A', 'reseeded', 'corrupt'), JSON.stringify(line({ id: 'evt-a', session: 'A', first_login: true, previous_login_at: null }))].join('\n') + '\n',
    );
    await writeFile(
      join(d, 'b.jsonl'),
      [JSON.stringify(line({ id: 'evt-b', session: 'B', ts: '2026-09-30T09:00:00.000Z' })), ref('B', 'write_failed', 'io_error')].join('\n') + '\n',
    );
    const views = await readConnectorChanges(d);
    expect(views.map((v) => [v.event_id, v.authorization?.reference_note])).toEqual([
      ['evt-b', 'write_failed'],
      ['evt-a', 'reseeded'],
    ]);
  });

  it('honours the mcp filter, and a no-change login stays out', async () => {
    const d = join(dir, 'filter');
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, 's.jsonl'),
      [
        JSON.stringify(line({ id: 'same', session: 'X' })),
        JSON.stringify(line({ id: 'first-notion', session: 'Y', mcp: 'notion', first_login: true, previous_login_at: null })),
      ].join('\n') + '\n',
    );
    expect((await readConnectorChanges(d)).map((v) => v.event_id)).toEqual(['first-notion']);
    expect(await readConnectorChanges(d, { mcp: 'github' })).toEqual([]);
  });
});
