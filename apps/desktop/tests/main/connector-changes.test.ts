// Reading both formats. The load-bearing half is the reconstruction: four
// months of history has to keep meaning what it meant, without the trail being
// rewritten and without a reconstruction ever passing for a native record.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONNECTOR_CHANGE_TYPE } from '@xcg/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseAuditContent, readAudit } from '../../src/main/detection-reader.js';
import { computeTrayCounts } from '../../src/main/tray.js';
import { REVIEW_STATUS_CHANGED_TYPE } from '@xcg/shared';
import {
  UNVERSIONED,
  foldReviewStatus,
  reviewMarkerOfLine,
  fromLegacyLine,
  fromNativeLine,
  readConnectorChanges,
  viewOfLine,
} from '../../src/main/connector-changes.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'xcg-connector-changes-'));
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

let n = 0;

/** A historical line, exactly the shape the trail holds: an enrichment,
 *  server_to_client, carrying the whole detection block. */
function legacy(findings: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: `L${(n += 1)}`,
    ts: '2026-07-06T10:00:00.000Z',
    session: 'S',
    mcp: 'notion',
    type: 'mcp.detection_enrichment',
    rpcId: 7,
    direction: 'server_to_client',
    detection: { category: 'tool_manifest_changed', severity: 'high', findings },
    ...over,
  };
}

function native(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: `N${(n += 1)}`,
    ts: '2026-09-24T10:00:00.000Z',
    session: 'S',
    mcp: 'notion',
    type: CONNECTOR_CHANGE_TYPE,
    section: 'prompts',
    snapshot: { before: 'sha256:a', after: 'sha256:b' },
    changes: [{ kind: 'description_changed', target: 'search' }],
    findings: [],
    attention: { level: 'normal' },
    ...over,
  };
}

async function dirWith(...lines: unknown[]): Promise<string> {
  const d = join(tmpDir, `case-${(n += 1)}`);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return d;
}

describe('historical lines are reconstructed, never reinterpreted', () => {
  it('shape findings become changes and rule findings become findings', () => {
    const v = fromLegacyLine(
      legacy([
        { type: 'description_changed', location: 'search' },
        { type: 'surface_added', location: 'search' },
        { type: 'sensitive_param_added', location: 'search.webhook_url' },
      ]),
    );
    expect(v?.changes.map((c) => c.kind)).toEqual(['description_changed', 'surface_added']);
    expect(v?.findings.map((f) => f.rule_id)).toEqual(['sensitive_param_added']);
  });

  it('tool_added / tool_removed map to the section-neutral item vocabulary', () => {
    const v = fromLegacyLine(
      legacy([
        { type: 'tool_added', location: 'a' },
        { type: 'tool_removed', location: 'b' },
      ]),
    );
    expect(v?.changes).toEqual([
      { kind: 'item_added', target: 'a' },
      { kind: 'item_removed', target: 'b' },
    ]);
  });

  it('findings that predate versioning say so — 0, never 1', () => {
    const v = fromLegacyLine(legacy([{ type: 'injection_marker', location: 's', rule: 'injection_pattern' }]));
    expect(v?.findings[0]?.rule_version).toBe(UNVERSIONED);
    expect(v?.findings[0]?.rule_version).not.toBe(1);
  });

  it('per-finding severity is what the rule meant then, not the event maximum', () => {
    // One event, two rules of different weight. Stamping the event's 'high'
    // onto both would overstate the zero-width one.
    const v = fromLegacyLine(
      legacy([
        { type: 'injection_marker', location: 's', rule: 'injection_pattern' },
        { type: 'hidden_characters', location: 's', rule: 'zero_width', codepoint: 'U+200B', count: 3 },
      ]),
    );
    expect(v?.findings.map((f) => f.severity)).toEqual(['high', 'medium']);
  });

  it('a tag or bidi class was high, and still reads as high', () => {
    for (const rule of ['tag', 'bidi']) {
      const v = fromLegacyLine(legacy([{ type: 'hidden_characters', location: 's', rule }]));
      expect(v?.findings[0]?.severity, rule).toBe('high');
    }
  });

  it('hidden-character evidence keeps the codepoint and the count', () => {
    const v = fromLegacyLine(
      legacy([{ type: 'hidden_characters', location: 's', path: '$.description', rule: 'bidi', codepoint: 'U+202E', count: 2 }]),
    );
    expect(v?.findings[0]?.evidence).toEqual({
      target: 's',
      path: '$.description',
      rule: 'bidi',
      codepoint: 'U+202E',
      count: 2,
    });
  });

  it('sensitive_param_added splits tool from parameter, as it was written', () => {
    const v = fromLegacyLine(legacy([{ type: 'sensitive_param_added', location: 'send.webhook_url' }]));
    expect(v?.findings[0]?.evidence.target).toBe('send');
    expect(v?.findings[0]?.evidence.path).toBe('send.webhook_url');
  });

  it('informational findings are dropped — they are neither fact nor verdict', () => {
    const v = fromLegacyLine(
      legacy([
        { type: 'description_changed', location: 's' },
        { type: 'external_url', location: 's' },
        { type: 'imperative_language', location: 's' },
        { type: 'external_ref', location: 's', rule: 'not_resolved' },
      ]),
    );
    expect(v?.changes).toHaveLength(1);
    expect(v?.findings).toHaveLength(0);
  });

  it('a reconstruction cannot pass for a native record', () => {
    const v = fromLegacyLine(legacy([{ type: 'description_changed', location: 's' }]));
    expect(v?.source_format).toBe('tool_manifest_changed_v1');
    expect(v?.snapshot).toBeNull();
    expect(v?.attention).toEqual({ level: 'normal' });
  });

  it('the old detector only ever watched tools, so the section says tools', () => {
    expect(fromLegacyLine(legacy([{ type: 'tool_added', location: 'a' }]))?.section).toBe('tools');
  });

  it('another enrichment category is not a manifest change', () => {
    const line = legacy([{ type: 'x', location: 'y' }]);
    (line['detection'] as Record<string, unknown>)['category'] = 'credential_detected';
    expect(fromLegacyLine(line)).toBeNull();
  });

  it('a line whose findings are all informational yields nothing at all', () => {
    expect(fromLegacyLine(legacy([{ type: 'external_url', location: 's' }]))).toBeNull();
  });
});

describe('what the real history holds', () => {
  it('a legacy line graded high by the retired rule carries no finding at all', () => {
    // Measured 24/09 over the operator's trail: 317 manifest lines, zero
    // security-rule findings. The 91 graded `high` were graded by the
    // pre-shape rule retired that day. Carrying that severity forward would
    // launder a judgement the product stopped trusting, so it is dropped and
    // the event lands in Changes with no finding.
    const v = fromLegacyLine(
      legacy(
        [
          { type: 'description_changed', location: 'apollo_people_bulk_match' },
          { type: 'schema_changed', location: 'apollo_people_bulk_match' },
        ],
        { detection: { category: 'tool_manifest_changed', severity: 'high', findings: [
          { type: 'description_changed', location: 'apollo_people_bulk_match' },
          { type: 'schema_changed', location: 'apollo_people_bulk_match' },
        ] } },
      ),
    );
    expect(v?.findings).toEqual([]);
    expect(v?.changes).toHaveLength(2);
  });
});

describe('native lines pass through', () => {
  it('keeps section, snapshot and attention verbatim', () => {
    const v = fromNativeLine(
      native({ attention: { level: 'review_recommended', heuristic_id: 'h', heuristic_version: 1 } }),
    );
    expect(v?.section).toBe('prompts');
    expect(v?.snapshot).toEqual({ before: 'sha256:a', after: 'sha256:b' });
    expect(v?.attention).toEqual({ level: 'review_recommended', heuristic_id: 'h', heuristic_version: 1 });
    expect(v?.source_format).toBeUndefined();
  });

  it('a native line with no findings is still a change', () => {
    expect(fromNativeLine(native({ findings: [] }))?.changes).toHaveLength(1);
  });

  it('rejects a line missing either list', () => {
    expect(fromNativeLine(native({ changes: undefined }))).toBeNull();
    expect(fromNativeLine(native({ findings: undefined }))).toBeNull();
  });
});

describe('one reader, both formats', () => {
  it('viewOfLine takes either and rejects everything else', () => {
    expect(viewOfLine(JSON.stringify(native()))?.source_format).toBeUndefined();
    expect(viewOfLine(JSON.stringify(legacy([{ type: 'tool_added', location: 'a' }])))?.source_format).toBe(
      'tool_manifest_changed_v1',
    );
    expect(viewOfLine('{ not json')).toBeNull();
    expect(viewOfLine(JSON.stringify({ type: 'mcp.request' }))).toBeNull();
  });

  it('reads a mixed directory newest first', async () => {
    const d = await dirWith(
      legacy([{ type: 'tool_added', location: 'a' }], { ts: '2026-07-06T10:00:00.000Z' }),
      native({ ts: '2026-09-24T10:00:00.000Z' }),
    );
    const rows = await readConnectorChanges(d);
    expect(rows.map((r) => r.ts)).toEqual([
      '2026-09-24T10:00:00.000Z',
      '2026-07-06T10:00:00.000Z',
    ]);
  });

  it('filters by connector and respects the limit', async () => {
    const d = await dirWith(
      native({ mcp: 'notion' }),
      native({ mcp: 'stripe' }),
      legacy([{ type: 'tool_added', location: 'a' }], { mcp: 'stripe' }),
    );
    expect(await readConnectorChanges(d, { mcp: 'stripe' })).toHaveLength(2);
    expect(await readConnectorChanges(d, { limit: 1 })).toHaveLength(1);
  });

  it('an absent directory is empty, not an error', async () => {
    await expect(readConnectorChanges(join(tmpDir, 'nope'))).resolves.toEqual([]);
  });

  it('a malformed line never loses the good ones around it', async () => {
    const d = join(tmpDir, `case-${(n += 1)}`);
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, 's.jsonl'),
      `{ broken\n${JSON.stringify(native())}\n\n${JSON.stringify(legacy([{ type: 'tool_removed', location: 'z' }]))}\n`,
    );
    expect(await readConnectorChanges(d)).toHaveLength(2);
  });
});

describe('connector_change is inert for every counted surface', () => {
  // The load-bearing half of the model. Four months of production say 197 of
  // 217 changes carry no finding; letting any of them reach a counter would
  // inflate exactly the number the user reads as "things worth looking at".
  const lines = [
    native({ findings: [] }),
    native({
      findings: [
        {
          rule_id: 'sensitive_param_added',
          rule_version: 1,
          severity: 'high',
          evidence: { target: 'send', path: 'send.webhook_url' },
        },
      ],
    }),
    native({ attention: { level: 'review_recommended', heuristic_id: 'h', heuristic_version: 1 } }),
  ];
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  it('produces no detection event, no auth signal and no outcome', () => {
    const parsed = parseAuditContent(content);
    expect(parsed.events).toEqual([]);
    expect(parsed.authSignals).toEqual([]);
    expect(parsed.outcomes?.size ?? 0).toBe(0);
  });

  it('never reaches the tray counters, findings or not', () => {
    const parsed = parseAuditContent(content);
    expect(computeTrayCounts(parsed.events, Date.parse('2026-09-24T12:00:00.000Z'))).toEqual({
      flagged24h: 0,
      critical24h: 0,
    });
  });

  it('never appears as a Detections row', async () => {
    const d = await dirWith(...lines);
    const audit = await readAudit(d, Date.parse('2026-09-24T12:00:00.000Z'));
    expect(audit.events).toEqual([]);
    expect(audit.authAlerts).toEqual([]);
  });

  it('a review marker is inert too — it is bookkeeping, not evidence of risk', async () => {
    const line = JSON.stringify({
      v: 1, id: 'M0', ts: '2026-09-24T11:00:00.000Z', session: 'desktop',
      type: REVIEW_STATUS_CHANGED_TYPE, target_event_id: 'E1', from: 'unreviewed', to: 'reviewed',
    });
    const parsed = parseAuditContent(line + '\n');
    expect(parsed.events).toEqual([]);
    expect(parsed.authSignals).toEqual([]);
    expect(computeTrayCounts(parsed.events, Date.parse('2026-09-24T12:00:00.000Z'))).toEqual({
      flagged24h: 0, critical24h: 0,
    });
  });

  it('but the change reader does see all three', async () => {
    const d = await dirWith(...lines);
    expect(await readConnectorChanges(d)).toHaveLength(3);
  });
});

describe('review status is folded, never stored on the event', () => {
  const marker = (target: string, to: 'reviewed' | 'unreviewed', ts: string): Record<string, unknown> => ({
    v: 1,
    id: `M${(n += 1)}`,
    ts,
    session: 'desktop',
    type: REVIEW_STATUS_CHANGED_TYPE,
    target_event_id: target,
    from: to === 'reviewed' ? 'unreviewed' : 'reviewed',
    to,
  });

  it('a change with no marker pointing at it is unreviewed', async () => {
    const d = await dirWith(native());
    expect((await readConnectorChanges(d))[0]?.review_status).toBe('unreviewed');
  });

  it('a marker moves the status and records the step', async () => {
    const ev = native();
    const d = await dirWith(ev, marker(ev['id'] as string, 'reviewed', '2026-09-24T11:00:00.000Z'));
    const row = (await readConnectorChanges(d))[0];
    expect(row?.review_status).toBe('reviewed');
    expect(row?.review_history).toEqual([
      { ts: '2026-09-24T11:00:00.000Z', from: 'unreviewed', to: 'reviewed' },
    ]);
  });

  it('the last marker in time wins, whatever order the files are read in', async () => {
    const ev = native();
    const id = ev['id'] as string;
    const d = await dirWith(
      ev,
      marker(id, 'unreviewed', '2026-09-24T13:00:00.000Z'),
      marker(id, 'reviewed', '2026-09-24T12:00:00.000Z'),
    );
    const row = (await readConnectorChanges(d))[0];
    expect(row?.review_status).toBe('unreviewed');
    expect(row?.review_history.map((h) => h.to)).toEqual(['reviewed', 'unreviewed']);
  });

  it('a marker for a change that is not there is dropped, never invented', () => {
    const rows = foldReviewStatus(
      [],
      [{ ts: '2026-09-24T11:00:00.000Z', target_event_id: 'gone', from: 'unreviewed', to: 'reviewed' }],
    );
    expect(rows).toEqual([]);
  });

  it('a new change starts unreviewed even when an identical one was reviewed', async () => {
    // The property that matters: review status follows the EVENT, not the
    // content. A surface that goes back to a state someone already signed off
    // produces a new event with a new id, and no marker points at it.
    const first = native({ id: 'E1', ts: '2026-09-24T10:00:00.000Z' });
    const again = native({ id: 'E2', ts: '2026-09-24T12:00:00.000Z' });
    const d = await dirWith(first, marker('E1', 'reviewed', '2026-09-24T11:00:00.000Z'), again);
    const rows = await readConnectorChanges(d);
    expect(rows.map((r) => [r.event_id, r.review_status])).toEqual([
      ['E2', 'unreviewed'],
      ['E1', 'reviewed'],
    ]);
  });

  it('a marker is never mistaken for a change', () => {
    const line = JSON.stringify(marker('E1', 'reviewed', '2026-09-24T11:00:00.000Z'));
    expect(viewOfLine(line)).toBeNull();
    expect(reviewMarkerOfLine(line)?.target_event_id).toBe('E1');
    expect(reviewMarkerOfLine(JSON.stringify(native()))).toBeNull();
  });

  it('historical changes can be reviewed too', async () => {
    const ev = legacy([{ type: 'tool_added', location: 'a' }]);
    const d = await dirWith(ev, marker(ev['id'] as string, 'reviewed', '2026-09-24T11:00:00.000Z'));
    expect((await readConnectorChanges(d))[0]?.review_status).toBe('reviewed');
  });
});
