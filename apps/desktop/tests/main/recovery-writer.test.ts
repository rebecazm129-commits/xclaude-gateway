import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  writeCchookRemoved,
  writeConnectorRecovered,
  writeRecoveryMarkerAfterConnect,
  APP_EVENTS_FILENAME,
  CCHOOK_REMOVED_TYPE,
  CONNECTOR_RECOVERED_TYPE,
} from '../../src/main/recovery-writer.js';
import { parseAuditContent } from '../../src/main/detection-reader.js';

let tmpDir: string;
beforeAll(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'xcg-recovery-')); });
afterAll(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe('writeConnectorRecovered', () => {
  it('appends a well-formed app.connector_recovered envelope', async () => {
    const dir = join(tmpDir, 'one');
    writeConnectorRecovered('stripe', dir);
    const content = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev).toMatchObject({ v: 1, session: 'desktop', mcp: 'stripe', type: CONNECTOR_RECOVERED_TYPE });
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.ts).toBe('string');
    expect(() => new Date(ev.ts).toISOString()).not.toThrow();
  });

  it('appends (does not overwrite) across repeated calls', async () => {
    const dir = join(tmpDir, 'many');
    writeConnectorRecovered('a', dir);
    writeConnectorRecovered('b', dir);
    const content = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).mcp).toBe('a');
    expect(JSON.parse(lines[1]!).mcp).toBe('b');
  });

  it('creates the wrappers dir if missing', async () => {
    const dir = join(tmpDir, 'nested', 'deep');
    writeConnectorRecovered('x', dir);
    const content = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });
});

// F1-01: the marker fires on EVERY successful connect — fresh connects included,
// because Remove deletes the config entry and Keychain items but not the audit
// JSONL, so a re-add under the same name inherits the historical alert.
describe('writeRecoveryMarkerAfterConnect', () => {
  it('successful fresh connect → marker written for the connector name', () => {
    const write = vi.fn();
    writeRecoveryMarkerAfterConnect({ ok: true }, 'gmail', write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('gmail');
  });

  it('failed connect → no marker', () => {
    const write = vi.fn();
    writeRecoveryMarkerAfterConnect({ ok: false }, 'gmail', write);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('writeCchookRemoved', () => {
  it('appends a well-formed app.cchook_removed envelope', async () => {
    const dir = join(tmpDir, 'cchook');
    writeCchookRemoved('/Users/user/.claude/settings.json', dir);
    const content = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev).toMatchObject({
      v: 1,
      session: 'desktop',
      mcp: 'claude-code',
      type: CCHOOK_REMOVED_TYPE,
      settingsPath: '/Users/user/.claude/settings.json',
    });
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.ts).toBe('string');
    expect(() => new Date(ev.ts).toISOString()).not.toThrow();
  });

  // Pin of the inertness contract (same claim the purge marker makes): the
  // marker matches none of the reader's guards — no detection event, no auth
  // signal, no outcome. If a future reader guard starts matching 'app.*'
  // lines, this test detects it.
  it('is inert for the reader: no detection event, no auth signal, no outcome', async () => {
    const dir = join(tmpDir, 'cchook-inert');
    writeCchookRemoved('/Users/user/.claude/settings.json', dir);
    const content = await readFile(join(dir, APP_EVENTS_FILENAME), 'utf8');
    const parsed = parseAuditContent(content);
    expect(parsed.events).toEqual([]);
    expect(parsed.authSignals).toEqual([]);
    expect(parsed.outcomes?.size ?? 0).toBe(0);
  });
});
