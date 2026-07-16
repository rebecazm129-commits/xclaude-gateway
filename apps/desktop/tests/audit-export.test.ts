import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CSV_HEADER, csvRow, exportAudit } from '../src/main/audit-export.js';
import { matchesFilter, paginate } from '../src/main/detection-page.js';
import { readAudit } from '../src/main/detection-reader.js';
import type {
  Category,
  DetectionFilter,
  EnrichableEvent,
  Severity,
} from '../src/shared/types.js';

const NOW = Date.parse('2026-07-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offset = 0): string => new Date(NOW + offset).toISOString();

const CATS: Category[] = [
  'credential_detected', 'prompt_injection', 'email_send_warning',
  'data_export_warning', 'tool_call_allowed', 'pii_detected',
  'pii_structured', 'tool_manifest_changed',
];
const SEVS: Severity[] = ['low', 'medium', 'high', 'critical'];
const ALL: DetectionFilter = {
  mcp: null, timeRange: 'all', categories: [...CATS], severities: [...SEVS],
  sources: ['gateway', 'claude-code'],
};

function reqLine(
  id: string,
  ts: string,
  o: { mcp?: string; category?: Category; severity?: Severity; params?: unknown; source?: string } = {},
): string {
  return JSON.stringify({
    v: 1, id, ts, session: 's', mcp: o.mcp ?? 'notion', type: 'mcp.request',
    direction: 'client_to_server', rpcId: 1, method: 'tools/call',
    params: o.params ?? { name: 'echo', arguments: { text: 'hi' } },
    bytes: 50, overheadUs: 7,
    ...(o.source !== undefined ? { source: o.source } : {}),
    detection: { category: o.category ?? 'tool_call_allowed', severity: o.severity ?? 'low', findings: [] },
  });
}
function enrLine(
  id: string,
  ts: string,
  o: { mcp?: string; category?: Category; severity?: Severity; findings?: unknown[] } = {},
): string {
  return JSON.stringify({
    v: 1, id, ts, session: 's', mcp: o.mcp ?? 'notion', type: 'mcp.detection_enrichment',
    rpcId: 1, direction: 'server_to_client',
    detection: {
      category: o.category ?? 'pii_detected',
      severity: o.severity ?? 'medium',
      findings: o.findings ?? [{ type: 'email', location: 'result' }],
    },
  });
}
function respLine(id: string, ts: string): string {
  return JSON.stringify({
    v: 1, id, ts, session: 's', mcp: 'notion', type: 'mcp.response',
    direction: 'server_to_client', rpcId: 1, bytes: 20, result: { ok: true },
  });
}

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xcg-export-'));
  dir = join(root, 'wrappers');
  await mkdir(dir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function writeSession(name: string, ...lines: string[]): Promise<void> {
  await writeFile(join(dir, name), lines.join('\n') + '\n');
}

describe('exportAudit — JSONL raw', () => {
  it('exports matching detection lines verbatim, ts asc, response excluded', async () => {
    const bigParams = { name: 'search', arguments: { blob: '[truncated 99999 bytes]' } };
    const aRaw = reqLine('a', iso(2000), { category: 'credential_detected', severity: 'critical', params: bigParams });
    await writeSession(
      '01A.jsonl',
      respLine('r0', iso(0)), // not a detection → excluded
      aRaw,
      enrLine('e', iso(1000), { category: 'pii_detected', severity: 'medium' }),
      reqLine('b', iso(3000)),
    );
    const dest = join(root, 'out.jsonl');
    const { count } = await exportAudit({ dir, destPath: dest, filter: ALL, format: 'jsonl', now: NOW });
    expect(count).toBe(3); // a, e, b — the mcp.response is excluded
    const out = readFileSync(dest, 'utf8').trimEnd().split('\n');
    // ts asc: e(1000) < a(2000) < b(3000)
    expect(out.map((l) => JSON.parse(l).id)).toEqual(['e', 'a', 'b']);
    // Verbatim: the 'a' line equals the raw input (params + truncated marker intact).
    expect(out[1]).toBe(aRaw);
    // The enrichment is its own line.
    expect(JSON.parse(out[0]!).type).toBe('mcp.detection_enrichment');
  });

  it('golden oracle: exported ids === paginate matching for the same filter (ts ties)', async () => {
    const mcps = ['notion', 'linear', 'stripe'];
    const tsPool = [0, 0, 0, -1000, -1000, -HOUR, -25 * HOUR, -8 * 24 * HOUR];
    const lines: string[] = [];
    let s = 7;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    for (let i = 0; i < 300; i++) {
      lines.push(reqLine(`e${i}`, iso(pick(tsPool)), { mcp: pick(mcps), category: pick(CATS), severity: pick(SEVS) }));
    }
    await writeSession('01A.jsonl', ...lines.slice(0, 150));
    await writeSession('01B.jsonl', ...lines.slice(150));

    const filters: DetectionFilter[] = [
      ALL,
      { ...ALL, mcp: 'notion' },
      { ...ALL, timeRange: '24h' },
      { ...ALL, timeRange: '1h', severities: ['critical', 'high'] },
      { ...ALL, categories: ['tool_call_allowed', 'pii_detected'] },
    ];
    const events = (await readAudit(dir, NOW)).events;
    for (const f of filters) {
      const dest = join(root, 'oracle.jsonl');
      await exportAudit({ dir, destPath: dest, filter: f, format: 'jsonl', now: NOW });
      const lines2 = readFileSync(dest, 'utf8').trim().split('\n').filter(Boolean);
      const exportedIds = lines2.map((l) => JSON.parse(l).id as string);
      const refIds = paginate(events, f, events.length + 1, null, NOW).rows.map((r) => r.id);
      expect([...exportedIds].sort()).toEqual([...refIds].sort());
      // exporter order is ts asc
      const tsSeq = lines2.map((l) => JSON.parse(l).ts as string);
      expect(tsSeq).toEqual([...tsSeq].sort());
      // sanity: the same set matchesFilter directly
      expect(exportedIds.length).toBe(events.filter((e) => matchesFilter(e, f, NOW)).length);
    }
  });
});

describe('exportAudit — CSV', () => {
  it('writes header + one row per event; enrichments have empty method/tool', async () => {
    await writeSession(
      '01A.jsonl',
      reqLine('a', iso(1000), {
        mcp: 'no,tion',
        category: 'credential_detected',
        severity: 'critical',
        params: { name: 'weird"tool', arguments: {} },
      }),
      enrLine('e', iso(2000), { category: 'pii_detected', severity: 'medium', findings: [{ type: 'email' }, { type: 'iban' }] }),
    );
    const dest = join(root, 'out.csv');
    await exportAudit({ dir, destPath: dest, filter: ALL, format: 'csv', now: NOW });
    const rows = readFileSync(dest, 'utf8').trimEnd().split('\n');
    expect(rows[0]).toBe(CSV_HEADER);
    // ts asc: a(1000) then e(2000). mcp quoted (comma), tool quoted (inner quote doubled).
    expect(rows[1]).toBe(
      `${iso(1000)},"no,tion",mcp.request,tools/call,"weird""tool",credential_detected,critical,0`,
    );
    expect(rows[2]).toBe(`${iso(2000)},notion,mcp.detection_enrichment,,,pii_detected,medium,2`);
  });

  it('sources filter: claude-code-only exports only synthesized lines (via shared matchesFilter)', async () => {
    await writeSession(
      '01B.jsonl',
      [
        reqLine('gw', iso(1000)), // wrapper line: no source field
        reqLine('cc', iso(2000), { source: 'claude-code' }),
      ].join('\n'),
    );
    const filter: DetectionFilter = { ...ALL, sources: ['claude-code'] };
    const dest = join(root, 'cc-only.jsonl');
    const { count } = await exportAudit({ dir, destPath: dest, filter, format: 'jsonl', now: NOW });
    expect(count).toBe(1);
    const lines = readFileSync(dest, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] as string) as { id: string }).id).toBe('cc');
  });

  it('empty result → CSV header only; JSONL empty', async () => {
    await writeSession('01A.jsonl', reqLine('a', iso(0), { severity: 'low' }));
    const filter: DetectionFilter = { ...ALL, severities: ['critical'] };
    const destC = join(root, 'out.csv');
    await exportAudit({ dir, destPath: destC, filter, format: 'csv', now: NOW });
    expect(readFileSync(destC, 'utf8')).toBe(`${CSV_HEADER}\n`);
    const destJ = join(root, 'out.jsonl');
    const { count } = await exportAudit({ dir, destPath: destJ, filter, format: 'jsonl', now: NOW });
    expect(count).toBe(0);
    expect(readFileSync(destJ, 'utf8')).toBe('');
  });
});

describe('csvRow — RFC 4180 escaping', () => {
  function reqEvent(over: Partial<EnrichableEvent> = {}): EnrichableEvent {
    return {
      id: 'x', ts: 't', session: 's', mcp: 'm', type: 'mcp.request',
      method: 'tools/call', rpcId: 1, direction: 'client_to_server', toolName: 'echo',
      detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
      ...over,
    } as EnrichableEvent;
  }
  it('quotes a comma field', () => {
    expect(csvRow(reqEvent({ mcp: 'a,b' }))).toBe('t,"a,b",mcp.request,tools/call,echo,tool_call_allowed,low,0');
  });
  it('doubles inner quotes', () => {
    expect(csvRow(reqEvent({ toolName: 'we"ird' }))).toContain('"we""ird"');
  });
  it('quotes an embedded newline', () => {
    expect(csvRow(reqEvent({ mcp: 'a\nb' }))).toContain('"a\nb"');
  });
});

describe('exportAudit — resilience', () => {
  it('skips an unreadable entry (a dir named *.jsonl) and exports the rest', async () => {
    await writeSession('good.jsonl', reqLine('a', iso(0)));
    await mkdir(join(dir, 'bad.jsonl'));
    const dest = join(root, 'out.jsonl');
    const { count } = await exportAudit({ dir, destPath: dest, filter: ALL, format: 'jsonl', now: NOW });
    expect(count).toBe(1);
    expect(JSON.parse(readFileSync(dest, 'utf8').trim()).id).toBe('a');
  });

  it('on a write/rename failure leaves no partial destination and cleans up the tmp', async () => {
    await writeSession('01A.jsonl', reqLine('a', iso(0)));
    // Destination is an existing directory → rename(tmp, dir) fails.
    const destDir = join(root, 'dest-is-a-dir');
    await mkdir(destDir);
    await expect(
      exportAudit({ dir, destPath: destDir, filter: ALL, format: 'jsonl', now: NOW }),
    ).rejects.toThrow();
    expect(existsSync(destDir)).toBe(true); // untouched
    expect(existsSync(`${destDir}.xcg-export.${process.pid}.tmp`)).toBe(false); // tmp cleaned
  });
});
