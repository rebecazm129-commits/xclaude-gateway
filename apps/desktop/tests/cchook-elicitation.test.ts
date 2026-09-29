// Claude Code elicitation end to end: spool → ingester → trail → AuditStore.
// What the user typed never lands in the trail; the ElicitationResult's action
// is attached to the last Elicitation of the same server and session — in the
// same read and across incremental chunks.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import { resetCchookStatusForTests, runCchookIngestCycle } from '../src/main/cchook-ingester.js';
import { createAuditStore } from '../src/main/audit-store.js';
import { parseAuditContent } from '../src/main/detection-reader.js';
import type { DetectionEvent } from '../src/shared/types.js';

const KEY = Buffer.from('desktop-fixture-key-desktop-fixt', 'utf8');
const TYPED_SECRET = 'hunter2-Correct-Horse-Battery';
const DEFAULT_VALUE = 'default-only-value-zzq';
const ENUM_VALUE = 'enum-choice-qqz';

const temps: string[] = [];
function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'xcg-elicit-'));
  temps.push(base);
  const spoolDir = join(base, 'spool');
  mkdirSync(spoolDir, { recursive: true });
  return { spoolDir, wrappersDir: join(base, 'wrappers'), stateDir: base, hmacKey: KEY };
}
let seed = 1_000;
const spool = (spoolDir: string, payload: Record<string, unknown>): void => {
  writeFileSync(join(spoolDir, `${ulid((seed += 1_000))}.json`), JSON.stringify(payload));
};
const trailText = (wrappersDir: string): string =>
  readdirSync(wrappersDir)
    .map((f) => readFileSync(join(wrappersDir, f), 'utf8'))
    .join('');

const elicitation = (server: string, message: string, over: Record<string, unknown> = {}) => ({
  session_id: 'cc-sess-1',
  cwd: '/Users/x/code/p',
  hook_event_name: 'Elicitation',
  mcp_server_name: server,
  message,
  mode: 'form',
  requested_schema: {
    type: 'object',
    properties: {
      password: { type: 'string', title: 'Password', default: DEFAULT_VALUE },
      plan: { type: 'string', enum: [ENUM_VALUE] },
    },
    required: ['password'],
  },
  ...over,
});
// Raw, as an older hook would have left it — content included — so the
// ingest's whitelist is tested on its own.
const result = (server: string, action: string) => ({
  session_id: 'cc-sess-1',
  hook_event_name: 'ElicitationResult',
  mcp_server_name: server,
  mode: 'form',
  action,
  content: { password: TYPED_SECRET, plan: ENUM_VALUE },
});

const elicitRows = (events: readonly unknown[]): DetectionEvent[] =>
  (events as DetectionEvent[]).filter((e) => e.method === 'elicitation/create');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetCchookStatusForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('elicitation through the ingester', () => {
  it('content, defaults and enums never reach the trail', async () => {
    const d = dirs();
    spool(d.spoolDir, elicitation('srv', 'Log in'));
    spool(d.spoolDir, result('srv', 'accept'));
    await runCchookIngestCycle(d);
    const raw = trailText(d.wrappersDir);
    for (const v of [TYPED_SECRET, DEFAULT_VALUE, ENUM_VALUE, '"content"', '"default"', '"enum"']) {
      expect(raw).not.toContain(v);
    }
  });

  it('the action is attached to the Elicitation (row and panel); the result has no row of its own', async () => {
    const d = dirs();
    spool(d.spoolDir, elicitation('srv', 'Log in'));
    spool(d.spoolDir, result('srv', 'accept'));
    await runCchookIngestCycle(d);
    const store = createAuditStore(d.wrappersDir, { minRefreshMs: 0 });
    const { events } = await store.get();
    expect(events).toHaveLength(1);
    const [row] = elicitRows(events);
    expect(row!.elicitationAction).toBe('accept');
    expect(row!.detection).toMatchObject({ category: 'protocol_tripwire', severity: 'high' });
    expect(row!.outcome).toBeUndefined();

    const detail = await store.getDetail(row!.id);
    expect(detail?.elicitationAction).toBe('accept');
    expect(detail?.elicitation).toEqual({
      server: 'srv',
      mode: 'form',
      message: 'Log in',
      fields: [
        { name: 'password', type: 'string', title: 'Password', required: true },
        { name: 'plan', type: 'string', required: false },
      ],
    });
  });

  it('the action goes to the LAST Elicitation of the same server; another server is untouched', async () => {
    const d = dirs();
    spool(d.spoolDir, elicitation('srv', 'first'));
    spool(d.spoolDir, elicitation('other', 'other server'));
    spool(d.spoolDir, elicitation('srv', 'second'));
    spool(d.spoolDir, result('srv', 'decline'));
    await runCchookIngestCycle(d);
    const { events } = parseAuditContent(trailText(d.wrappersDir));
    const byMessage = new Map(elicitRows(events).map((e) => [e.elicitation?.message, e.elicitationAction]));
    expect(byMessage.get('second')).toBe('decline');
    expect(byMessage.get('first')).toBeUndefined();
    expect(byMessage.get('other server')).toBeUndefined();
  });

  it('a result in a later incremental chunk is backfilled onto the cached Elicitation', async () => {
    const d = dirs();
    spool(d.spoolDir, elicitation('srv', 'Log in'));
    await runCchookIngestCycle(d);
    const store = createAuditStore(d.wrappersDir, { minRefreshMs: 0, assembleTtlMs: 0 });
    expect(elicitRows((await store.get()).events)[0]!.elicitationAction).toBeUndefined();

    spool(d.spoolDir, result('srv', 'cancel'));
    await runCchookIngestCycle(d);
    expect(elicitRows((await store.get()).events)[0]!.elicitationAction).toBe('cancel');
  });

  it('an elicitation (rpcId null) never takes the outcome of a null-rpcId response', () => {
    const lines = [
      { v: 1, id: 'E1', ts: '2026-09-28T10:00:00.000Z', session: 'S', mcp: 'srv', type: 'mcp.request', direction: 'server_to_client', rpcId: null, method: 'elicitation/create', params: { mode: 'form' }, source: 'claude-code', ccSession: 'cc', detection: { category: 'protocol_tripwire', severity: 'medium', findings: [] } },
      { v: 1, id: 'R1', ts: '2026-09-28T10:00:01.000Z', session: 'S', mcp: 'claude-code', type: 'mcp.response', direction: 'server_to_client', rpcId: null, error: 'boom', source: 'claude-code' },
    ];
    const { events } = parseAuditContent(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(elicitRows(events)[0]!.outcome).toBeUndefined();
  });
});
