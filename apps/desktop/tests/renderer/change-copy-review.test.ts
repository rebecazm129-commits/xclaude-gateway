// The words for a catalog review: never "changed", "appeared" or "added" —
// nothing moved — and always the sentence saying so.

import { describe, expect, it } from 'vitest';

import {
  SEVERITY_DISCLAIMER,
  baselineNote,
  changeTitle,
  detailsLine,
  humanSummary,
  severityDisclaimer,
} from '../../src/renderer/components/change-copy.js';
import type { ConnectorChangeView } from '../../src/renderer/lib/xcgApi.js';

const view = (findings: ConnectorChangeView['findings'], over: Partial<ConnectorChangeView> = {}): ConnectorChangeView => ({
  event_id: 'r1',
  ts: '2026-09-27T10:00:00.000Z',
  mcp: 'notion',
  section: 'tools',
  snapshot: { before: null, after: 'sha256:cat' },
  changes: [],
  findings,
  attention: { level: 'normal' },
  review_status: 'unreviewed',
  review_history: [],
  review: 'baseline',
  reviewed_with: { injection_marker: 2 },
  ...over,
});
const inj = (target: string) => ({
  rule_id: 'injection_marker',
  rule_version: 2,
  severity: 'high' as const,
  evidence: { target, path: '$.description', rule: 'ignore_other_tools' },
});

describe('change copy — catalog review', () => {
  it('the note', () => {
    expect(baselineNote('notion')).toBe("Found in notion's existing definition. This does not mean it changed recently.");
  });

  it('the summary says what was found and where, then the note — never "appeared"', () => {
    const s = humanSummary(view([inj('send')]));
    expect(s).toBe(
      "Instruction-like text in send, at $.description. Found in notion's existing definition. This does not mean it changed recently.",
    );
    expect(s).not.toMatch(/appeared|was added/);
  });

  it('credential path and hidden characters read the same way', () => {
    expect(
      humanSummary(view([{ rule_id: 'sensitive_path_reference', rule_version: 1, severity: 'high', evidence: { target: 'read', path: '$.description', rule: 'ssh_private_key' } }])),
    ).toBe("A reference to a credential file in read, at $.description. Found in notion's existing definition. This does not mean it changed recently.");
    expect(
      humanSummary(view([{ rule_id: 'hidden_characters', rule_version: 2, severity: 'medium', evidence: { target: 'read', path: '$.description', rule: 'zero_width', codepoint: 'U+200B', count: 2 } }])),
    ).toBe("2 invisible characters (U+200B) in read. Found in notion's existing definition. This does not mean it changed recently.");
  });

  it('the title never says "changed"', () => {
    expect(changeTitle(view([inj('send')]))).toBe('Existing tool definition flagged');
    expect(changeTitle(view([inj('send'), inj('search')]))).toBe('2 existing definitions flagged');
  });

  it('the details line names the finding, as for a change', () => {
    expect(detailsLine(view([inj('send')]))).toBe('instruction-like text in send');
  });

  it('the sentence under the findings speaks of the existing definition', () => {
    expect(severityDisclaimer(view([inj('send')]))).toBe(
      'Severity describes what xCLAUDE found in this existing definition.',
    );
  });

  it('a change line keeps the current sentence', () => {
    const c = view([inj('send')], { review: undefined, changes: [{ kind: 'description_changed', target: 'send' }] });
    expect(severityDisclaimer(c)).toBe(SEVERITY_DISCLAIMER);
    expect(SEVERITY_DISCLAIMER).toBe(
      "Severity describes the change xCLAUDE observed. It doesn't mean the connector is malicious.",
    );
  });

  it('a change line is unaffected', () => {
    const c = view([inj('send')], { review: undefined, changes: [{ kind: 'description_changed', target: 'send' }] });
    expect(humanSummary(c)).toBe('Instruction-like text appeared in send, at $.description.');
    expect(changeTitle(c)).toBe('Tool definition changed');
  });
});
