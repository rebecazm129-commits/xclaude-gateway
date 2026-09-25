// The per-item lines in the change panel. What they must never do is make the
// reader decode an internal kind: schema_changed, surface_added and friends
// belong in Technical details.

import { describe, expect, it } from 'vitest';

import { itemLines } from '../../src/renderer/components/change-copy.js';
import type { ConnectorChangeView } from '../../src/renderer/lib/xcgApi.js';

const view = (changes: ConnectorChangeView['changes']): ConnectorChangeView => ({
  event_id: 'e1',
  ts: '2026-09-24T11:00:00.000Z',
  mcp: 'linear',
  section: 'tools',
  snapshot: { before: 'sha256:a', after: 'sha256:b' },
  changes,
  findings: [],
  attention: { level: 'normal' },
  review_status: 'unreviewed',
  review_history: [],
});

describe('itemLines', () => {
  it('one line per item, every kind it went through said in words', () => {
    expect(
      itemLines(
        view([
          { kind: 'description_changed', target: 'list_issues' },
          { kind: 'surface_added', target: 'list_issues', path: '$.inputSchema.properties.team' },
          { kind: 'schema_changed', target: 'list_documents' },
        ]),
      ),
    ).toEqual([
      { target: 'list_issues', text: 'Description changed; new parameter added' },
      { target: 'list_documents', text: 'Schema changed' },
    ]);
  });

  it('counts repeats instead of repeating them', () => {
    expect(
      itemLines(
        view([
          { kind: 'surface_added', target: 'send', path: '$.a' },
          { kind: 'surface_added', target: 'send', path: '$.b' },
          { kind: 'surface_removed', target: 'send', path: '$.c' },
        ]),
      ),
    ).toEqual([{ target: 'send', text: '2 new parameters added; parameter removed' }]);
  });

  it('never leaks an internal kind name', () => {
    const kinds: ConnectorChangeView['changes'][number]['kind'][] = [
      'item_added',
      'item_removed',
      'description_changed',
      'surface_added',
      'surface_removed',
      'schema_changed',
      'returned_to_seen_state',
    ];
    const text = itemLines(view(kinds.map((kind, i) => ({ kind, target: `t${i}` }))))
      .map((l) => l.text)
      .join(' ');
    for (const k of kinds) expect(text).not.toContain(k);
  });
});
