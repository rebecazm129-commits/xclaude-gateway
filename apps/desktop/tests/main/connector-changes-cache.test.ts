// The per-file cache of readConnectorChanges: a pass re-reads only new or
// changed files, a deleted file leaves the cache, a truncated or replaced one
// is re-read whole — and the result is always the same as a full read.

import { appendFileSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChangesFileCache, readConnectorChanges } from '../../src/main/connector-changes.js';
import { APP_EVENTS_FILENAME, writeReviewStatusChanged } from '../../src/main/recovery-writer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xcg-changes-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function change(mcp: string, ts: string, target = 'search'): string {
  seq += 1;
  return JSON.stringify({
    v: 1, id: `evt-${seq}`, ts, session: 'S', mcp, type: 'mcp.connector_change', section: 'tools',
    snapshot: { before: null, after: `sha256:${seq}` },
    changes: [{ kind: 'item_added', target }],
    findings: [{ rule_id: 'injection_marker', rule_version: 2, severity: 'high', evidence: { target } }],
    attention: { level: 'normal' },
  });
}
const noise = (n: number) => JSON.stringify({ v: 1, id: `n-${n}`, ts: '2026-09-30T10:00:00.000Z', session: 'S', mcp: 'x', type: 'mcp.request', method: 'tools/call' });
const write = (name: string, lines: string[]) => writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
const full = () => readConnectorChanges(dir, { limit: 5000 });

describe('readConnectorChanges with a per-file cache', () => {
  it('a second pass with nothing changed reads no file, and equals a full read', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z'), noise(1)]);
    write('b.jsonl', [noise(2), noise(3)]);
    const cache = createChangesFileCache();
    const first = await readConnectorChanges(dir, { limit: 5000, cache });
    expect([...cache.lastReads()].sort()).toEqual(['a.jsonl', 'b.jsonl']);
    const second = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual([]);
    expect(second).toEqual(first);
    expect(second).toEqual(await full());
  });

  it('a growing file is re-read (only it), and the new change shows', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    write('b.jsonl', [change('gmail', '2026-09-30T11:00:00.000Z')]);
    const cache = createChangesFileCache();
    await readConnectorChanges(dir, { limit: 5000, cache });
    appendFileSync(join(dir, 'a.jsonl'), `${change('notion', '2026-09-30T12:00:00.000Z', 'export')}\n`);
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual(['a.jsonl']);
    expect(after).toHaveLength(3);
    expect(after).toEqual(await full());
  });

  it('a new file is read; the others are not', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    const cache = createChangesFileCache();
    await readConnectorChanges(dir, { limit: 5000, cache });
    write('c.jsonl', [change('linear', '2026-09-30T13:00:00.000Z')]);
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual(['c.jsonl']);
    expect(after).toEqual(await full());
  });

  it('a deleted file (retention) leaves the cache and the list', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    write('b.jsonl', [change('gmail', '2026-09-30T11:00:00.000Z')]);
    const cache = createChangesFileCache();
    await readConnectorChanges(dir, { limit: 5000, cache });
    unlinkSync(join(dir, 'a.jsonl'));
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual([]);
    expect(cache.entries.has(join(dir, 'a.jsonl'))).toBe(false);
    expect(after.map((v) => v.mcp)).toEqual(['gmail']);
    expect(after).toEqual(await full());
  });

  it('a truncated file is re-read whole', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z'), change('notion', '2026-09-30T11:00:00.000Z')]);
    const cache = createChangesFileCache();
    await readConnectorChanges(dir, { limit: 5000, cache });
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual(['a.jsonl']);
    expect(after).toHaveLength(1);
    expect(after).toEqual(await full());
  });

  it('a file replaced by another (new inode) is re-read', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    const cache = createChangesFileCache();
    await readConnectorChanges(dir, { limit: 5000, cache });
    writeFileSync(join(dir, 'tmp'), `${change('slack', '2026-09-30T10:00:00.000Z')}\n`);
    renameSync(join(dir, 'tmp'), join(dir, 'a.jsonl'));
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual(['a.jsonl']);
    expect(after.map((v) => v.mcp)).toEqual(['slack']);
    expect(after).toEqual(await full());
  });

  it('cached views are never mutated by a pass (notified marks are copies)', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    const cache = createChangesFileCache();
    const [v] = await readConnectorChanges(dir, { limit: 5000, cache });
    appendFileSync(
      join(dir, APP_EVENTS_FILENAME),
      `${JSON.stringify({ v: 1, id: 'm', ts: '2026-09-30T10:05:00.000Z', session: 'desktop', mcp: 'notion', type: 'app.change_notified', target_event_id: v!.event_id, rule_id: 'x', shown: true })}\n`,
    );
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(after[0]!.notified).toBe(true);
    const cachedView = cache.entries.get(join(dir, 'a.jsonl'))!.parse.views[0]!;
    expect(cachedView.notified).toBeUndefined();
    expect(after).toEqual(await full());
  });
});

describe('marking a change reviewed through the cache', () => {
  it('the marker goes into the cached app-events entry: no re-read, same state as a full read', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z'), change('gmail', '2026-09-30T11:00:00.000Z')]);
    write(APP_EVENTS_FILENAME, [noise(9)]);
    const cache = createChangesFileCache();
    const before = await readConnectorChanges(dir, { limit: 5000, cache });
    const target = before.find((v) => v.mcp === 'notion')!;
    expect(target.review_status).toBe('unreviewed');

    const written = writeReviewStatusChanged(target.event_id, 'unreviewed', 'reviewed', dir);
    expect(written).not.toBeNull();
    await cache.noteAppended(written!.path, written!.bytes, written!.marker);
    const after = await readConnectorChanges(dir, { limit: 5000, cache });

    expect(cache.lastReads()).toEqual([]);
    expect(after.find((v) => v.event_id === target.event_id)!.review_status).toBe('reviewed');
    expect(after).toEqual(await full());
  });

  it('if something else was appended too, the entry is dropped and the file re-read — still the same as a full read', async () => {
    write('a.jsonl', [change('notion', '2026-09-30T10:00:00.000Z')]);
    write(APP_EVENTS_FILENAME, [noise(9)]);
    const cache = createChangesFileCache();
    const [target] = await readConnectorChanges(dir, { limit: 5000, cache });
    appendFileSync(join(dir, APP_EVENTS_FILENAME), `${noise(10)}\n`); // another writer
    const written = writeReviewStatusChanged(target!.event_id, 'unreviewed', 'reviewed', dir);
    await cache.noteAppended(written!.path, written!.bytes, written!.marker);
    const after = await readConnectorChanges(dir, { limit: 5000, cache });
    expect(cache.lastReads()).toEqual([APP_EVENTS_FILENAME]);
    expect(after[0]!.review_status).toBe('reviewed');
    expect(after).toEqual(await full());
  });

  it('unmarking a collapsed catalog review keeps the full-read result (the collapse is recomputed)', async () => {
    const review = (id: string, ts: string) =>
      JSON.stringify({
        v: 1, id, ts, session: 'S', mcp: 'acme', type: 'mcp.connector_change', section: 'tools',
        snapshot: { before: null, after: 'sha256:same' }, changes: [],
        findings: [{ rule_id: 'injection_marker', rule_version: 2, severity: 'high', evidence: { target: 't' } }],
        attention: { level: 'normal' }, review: 'baseline', reviewed_with: { injection_marker: 2 },
      });
    write('a.jsonl', [review('old', '2026-09-30T10:00:00.000Z'), review('new', '2026-09-30T11:00:00.000Z')]);
    write(APP_EVENTS_FILENAME, [noise(9)]);
    const cache = createChangesFileCache();
    // Mark the shown (newest) one reviewed, then unmark it.
    for (const to of ['reviewed', 'unreviewed'] as const) {
      const [shown] = await readConnectorChanges(dir, { limit: 5000, cache });
      const w = writeReviewStatusChanged(shown!.event_id, shown!.review_status, to, dir);
      await cache.noteAppended(w!.path, w!.bytes, w!.marker);
      expect(await readConnectorChanges(dir, { limit: 5000, cache })).toEqual(await full());
    }
  });
});
