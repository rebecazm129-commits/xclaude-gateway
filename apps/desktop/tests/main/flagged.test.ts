// What counts as flagged. One predicate, four callers — the tray badge, the
// connector list, the connector card and the Claude Code card — so the rule
// cannot hold in one number and not in another.

import { describe, expect, it } from 'vitest';

import { countsAsFlagged } from '../../src/shared/flagged.js';
import { computeTrayCounts } from '../../src/main/tray.js';
import type { EnrichableEvent } from '../../src/shared/types.js';

describe('countsAsFlagged', () => {
  it('the baseline never counts — it is emitted when nothing matched', () => {
    expect(countsAsFlagged('tool_call_allowed')).toBe(false);
  });

  it('a manifest change never counts — it lives in MCP changes now', () => {
    expect(countsAsFlagged('tool_manifest_changed')).toBe(false);
  });

  it('every risk category still counts', () => {
    for (const c of [
      'credential_detected',
      'prompt_injection',
      'email_send_warning',
      'data_export_warning',
      'pii_detected',
      'pii_structured',
    ] as const) {
      expect(countsAsFlagged(c), c).toBe(true);
    }
  });
});

describe('the tray badge', () => {
  const ev = (category: EnrichableEvent['detection']['category']): EnrichableEvent =>
    ({
      id: `e-${category}`,
      ts: '2026-09-24T11:59:00.000Z',
      session: 'S',
      mcp: 'notion',
      type: 'mcp.detection_enrichment',
      rpcId: 1,
      direction: 'server_to_client',
      detection: { category, severity: 'medium', findings: [] },
    }) as unknown as EnrichableEvent;

  const NOW = Date.parse('2026-09-24T12:00:00.000Z');

  it('does not count the 317 historical manifest lines', () => {
    // They arrive as server_to_client enrichments, which is exactly the shape
    // the badge counts, so nothing else was stopping them. Every one is a
    // shape change carrying no security finding.
    expect(computeTrayCounts([ev('tool_manifest_changed')], NOW)).toEqual({
      flagged24h: 0,
      critical24h: 0,
    });
  });

  it('still counts a real detection on the same shape of line', () => {
    expect(computeTrayCounts([ev('prompt_injection')], NOW).flagged24h).toBe(1);
  });

  it('a mixed batch counts only the real ones', () => {
    const events = [
      ev('tool_manifest_changed'),
      ev('tool_call_allowed'),
      ev('credential_detected'),
      ev('pii_detected'),
    ];
    expect(computeTrayCounts(events, NOW).flagged24h).toBe(2);
  });
});
