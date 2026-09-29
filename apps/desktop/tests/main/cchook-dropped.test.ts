// The ingester's side of the spool cap: the drop counter is taken each cycle,
// recorded in the trail as app.spool_dropped, added to the unseen total the
// Claude Code tab shows, and reset. Temp dirs only.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissUnseenDropped, processSpoolDropped, readUnseenDropped } from '../../src/main/cchook-dropped.js';
import { resetCchookStatusForTests, runCchookIngestCycle } from '../../src/main/cchook-ingester.js';

const dirs: string[] = [];
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'xcg-dropped-'));
  dirs.push(base);
  const stateDir = join(base, 'claude-code');
  const spoolDir = join(stateDir, 'spool');
  const wrappersDir = join(base, 'wrappers');
  mkdirSync(spoolDir, { recursive: true });
  return { stateDir, spoolDir, wrappersDir, counter: join(stateDir, 'spool-dropped') };
}
const appEvents = (wrappersDir: string): Record<string, unknown>[] => {
  const p = join(wrappersDir, 'app-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetCchookStatusForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('processSpoolDropped', () => {
  it('records the count and its time range in the trail, then resets the counter', () => {
    const d = setup();
    appendFileSync(d.counter, '....', { mode: 0o600 });
    expect(processSpoolDropped(d.counter, d.stateDir, d.wrappersDir)).toBe(4);
    const [line] = appEvents(d.wrappersDir);
    expect(line).toMatchObject({ type: 'app.spool_dropped', mcp: 'claude-code', session: 'desktop', count: 4 });
    expect(typeof line!['firstTs']).toBe('string');
    expect(typeof line!['lastTs']).toBe('string');
    expect(Date.parse(line!['firstTs'] as string)).toBeLessThanOrEqual(Date.parse(line!['lastTs'] as string));
    expect(existsSync(d.counter)).toBe(false);
    expect(readdirSync(d.stateDir).filter((f) => f.startsWith('spool-dropped.taking'))).toEqual([]);
    expect(readUnseenDropped(d.stateDir)).toMatchObject({ count: 4 });
  });

  it('nothing dropped → no trail line, nothing unseen', () => {
    const d = setup();
    expect(processSpoolDropped(d.counter, d.stateDir, d.wrappersDir)).toBe(0);
    expect(appEvents(d.wrappersDir)).toEqual([]);
    expect(readUnseenDropped(d.stateDir)).toBeNull();
  });

  it('the unseen total accumulates across cycles until dismissed', () => {
    const d = setup();
    appendFileSync(d.counter, '..');
    processSpoolDropped(d.counter, d.stateDir, d.wrappersDir);
    appendFileSync(d.counter, '...');
    processSpoolDropped(d.counter, d.stateDir, d.wrappersDir);
    expect(appEvents(d.wrappersDir).map((l) => l['count'])).toEqual([2, 3]);
    expect(readUnseenDropped(d.stateDir)).toMatchObject({ count: 5 });
    dismissUnseenDropped(d.stateDir);
    expect(readUnseenDropped(d.stateDir)).toBeNull();
  });

  it('a taken file left by an interrupted cycle is picked up by the next one', () => {
    const d = setup();
    writeFileSync(join(d.stateDir, 'spool-dropped.taking.123.456'), '..');
    appendFileSync(d.counter, '.');
    expect(processSpoolDropped(d.counter, d.stateDir, d.wrappersDir)).toBe(3);
    expect(readdirSync(d.stateDir).filter((f) => f.startsWith('spool-dropped'))).toEqual(['spool-dropped-unseen.json']);
  });
});

describe('through the ingest cycle', () => {
  it('every cycle takes the counter — even with an empty spool (a low-disk drop leaves no spool file)', async () => {
    const d = setup();
    appendFileSync(d.counter, '......');
    await runCchookIngestCycle({ spoolDir: d.spoolDir, wrappersDir: d.wrappersDir, stateDir: d.stateDir });
    expect(appEvents(d.wrappersDir)).toEqual([expect.objectContaining({ type: 'app.spool_dropped', count: 6 })]);
    expect(existsSync(d.counter)).toBe(false);
    await runCchookIngestCycle({ spoolDir: d.spoolDir, wrappersDir: d.wrappersDir, stateDir: d.stateDir });
    expect(appEvents(d.wrappersDir)).toHaveLength(1);
  });
});
