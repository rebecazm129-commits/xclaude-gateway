// Baseline lifecycle events: readable per connector, and INERT everywhere a
// number is shown. The second half is the load-bearing part — these events
// describe what the auditor did to its own state, and letting one reach the
// tray count or a flagged counter would inflate exactly the number the user
// reads as "things worth looking at".

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASELINE_EVENT_TYPE,
  isBaselineWarning,
  readBaselineHistory,
} from '../../src/main/baseline-history.js';
import { parseAuditContent, readAudit } from '../../src/main/detection-reader.js';
import { computeTrayCounts } from '../../src/main/tray.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-baseline-history-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

let n = 0;
function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: `e${(n += 1)}`,
    ts: '2026-09-24T10:00:00.000Z',
    session: 'S',
    mcp: 'notion',
    type: BASELINE_EVENT_TYPE,
    event: 'section_initialized',
    section: 'tools',
    ...over,
  };
}

async function dirWith(...events: Record<string, unknown>[]): Promise<string> {
  const d = join(tmpDir, `case-${(n += 1)}`);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 's.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return d;
}

describe('readBaselineHistory', () => {
  it('returns this connector’s events, newest first', async () => {
    const d = await dirWith(
      ev({ ts: '2026-09-24T10:00:00.000Z', section: 'tools' }),
      ev({ ts: '2026-09-24T11:00:00.000Z', section: 'prompts' }),
    );
    const h = await readBaselineHistory(d, 'notion');
    expect(h.map((e) => e.section)).toEqual(['prompts', 'tools']);
  });

  it('filters by connector', async () => {
    const d = await dirWith(ev({ mcp: 'notion' }), ev({ mcp: 'stripe' }));
    expect(await readBaselineHistory(d, 'stripe')).toHaveLength(1);
  });

  it('carries the migration coverage list', async () => {
    const d = await dirWith(
      ev({ event: 'migrated', section: undefined, coverageExpanded: ['tools[].title', 'section:prompts'] }),
    );
    const h = await readBaselineHistory(d, 'notion');
    expect(h[0]?.coverageExpanded).toEqual(['tools[].title', 'section:prompts']);
  });

  it('ignores unknown event kinds and malformed lines', async () => {
    const d = await dirWith(ev({ event: 'something_else' }), ev({ mcp: 42 }));
    expect(await readBaselineHistory(d, 'notion')).toEqual([]);
  });

  it('an absent directory is empty, not an error', async () => {
    await expect(readBaselineHistory(join(tmpDir, 'nope'), 'notion')).resolves.toEqual([]);
  });

  it('respects the limit', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      ev({ ts: `2026-09-24T10:${String(i).padStart(2, '0')}:00.000Z` }),
    );
    const d = await dirWith(...many);
    expect(await readBaselineHistory(d, 'notion')).toHaveLength(50);
    expect(await readBaselineHistory(d, 'notion', 5)).toHaveLength(5);
  });
});

describe('isBaselineWarning', () => {
  it('only snapshot_incomplete and a CORRUPT reseed are warnings', () => {
    expect(isBaselineWarning({ ts: '', mcp: 'm', event: 'snapshot_incomplete' })).toBe(true);
    expect(isBaselineWarning({ ts: '', mcp: 'm', event: 'reseeded', reason: 'corrupt' })).toBe(true);
    expect(isBaselineWarning({ ts: '', mcp: 'm', event: 'reseeded', reason: 'absent' })).toBe(false);
    for (const e of ['section_initialized', 'migrated', 'projection_migrated'] as const) {
      expect(isBaselineWarning({ ts: '', mcp: 'm', event: e }), e).toBe(false);
    }
  });
});

describe('baseline events are inert for every counted surface', () => {
  const all = [
    ev({ event: 'section_initialized' }),
    ev({ event: 'migrated' }),
    ev({ event: 'projection_migrated' }),
    ev({ event: 'reseeded', reason: 'corrupt' }),
    ev({ event: 'snapshot_incomplete' }),
  ];

  it('produce no detection event, no auth signal and no outcome', () => {
    const parsed = parseAuditContent(all.map((e) => JSON.stringify(e)).join('\n') + '\n');
    expect(parsed.events).toEqual([]);
    expect(parsed.authSignals).toEqual([]);
    expect(parsed.outcomes?.size ?? 0).toBe(0);
  });

  it('never appear as Detections rows', async () => {
    const d = await dirWith(...all);
    const audit = await readAudit(d, Date.parse('2026-09-24T12:00:00.000Z'));
    expect(audit.events).toEqual([]);
    expect(audit.authAlerts).toEqual([]);
  });

  it('never reach the tray counters', () => {
    const parsed = parseAuditContent(all.map((e) => JSON.stringify(e)).join('\n') + '\n');
    expect(computeTrayCounts(parsed.events, Date.parse('2026-09-24T12:00:00.000Z'))).toEqual({
      flagged24h: 0,
      critical24h: 0,
    });
  });

  it('a corrupt reseed is a WARNING but still not a detection', async () => {
    const d = await dirWith(ev({ event: 'reseeded', reason: 'corrupt' }));
    const h = await readBaselineHistory(d, 'notion');
    expect(isBaselineWarning(h[0]!)).toBe(true);
    const audit = await readAudit(d, Date.parse('2026-09-24T12:00:00.000Z'));
    expect(audit.events).toEqual([]);
  });
});
