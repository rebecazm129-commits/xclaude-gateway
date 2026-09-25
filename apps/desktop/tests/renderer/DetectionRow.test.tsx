// @vitest-environment jsdom
// Component tests for the tool label column of DetectionRow, plus the default
// category-filter membership. CSS modules are not processed under vitest, so
// assertions are by rendered text, not hashed class names.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DetectionRow } from '../../src/renderer/components/DetectionRow.js';
import { CATEGORY_OPTIONS } from '../../src/renderer/components/Detections.js';
import type { DetectionRowSlim } from '../../src/shared/types.js';

afterEach(cleanup);

function row(over: Partial<DetectionRowSlim> = {}): DetectionRowSlim {
  return {
    id: 'e1',
    ts: '2026-07-03T00:00:00.000Z',
    mcp: 'notion',
    type: 'mcp.detection_enrichment',
    category: 'pii_detected',
    severity: 'low',
    source: 'gateway',
    ...over,
  };
}

// The 08-15/09 trail audit found 6,132 baseline rows whose method is not
// tools/call rendering as "Tool call": initialize, tools/list, resources/list,
// prompts/list, resources/read — and, in the 2026-07-28 probe, server/discover.
describe('DetectionRow — category label for baseline rows', () => {
  const baseline = (method: string): DetectionRowSlim =>
    row({ type: 'mcp.request', category: 'tool_call_allowed', method, rpcId: 1, direction: 'client_to_server' } as Partial<DetectionRowSlim>);

  it('a real tools/call still reads "Tool call"', () => {
    render(<DetectionRow row={{ ...baseline('tools/call'), toolName: 'search' }} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Tool call')).toBeTruthy();
  });

  for (const m of ['initialize', 'tools/list', 'resources/list', 'prompts/list', 'resources/read', 'server/discover']) {
    it(`a ${m} baseline row does NOT read "Tool call"`, () => {
      render(<DetectionRow row={baseline(m)} selected={false} onClick={() => {}} />);
      expect(screen.queryByText('Tool call')).toBeNull();
      expect(screen.getByText('Protocol call')).toBeTruthy();
      // The method keeps its own column — the label must not duplicate it.
      expect(screen.getByText(m)).toBeTruthy();
    });
  }

  it('a row with no method at all falls back to the category label', () => {
    render(<DetectionRow row={row({ category: 'tool_call_allowed' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Tool call')).toBeTruthy();
  });

  it('non-baseline categories are never relabelled, whatever the method', () => {
    render(<DetectionRow row={row({ type: 'mcp.request', category: 'credential_detected', method: 'initialize', rpcId: 1, direction: 'client_to_server' } as Partial<DetectionRowSlim>)} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Credential leak')).toBeTruthy();
  });
});

describe('DetectionRow — tool column', () => {
  it('shows the tool name for a request row (never [NER])', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.request',
          category: 'tool_call_allowed',
          toolName: 'echo',
          method: 'tools/call',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('echo')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });

  it('shows the inherited toolName on an enrichment row — real tool beats the synthetic label (frente 3, cierre)', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.detection_enrichment',
          category: 'pii_detected',
          toolName: 'echo',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('echo')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });

  it('shows [NER] for a NER (pii_detected) enrichment row — the one place it was true', () => {
    render(
      <DetectionRow
        row={row({ type: 'mcp.detection_enrichment', category: 'pii_detected' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('[NER]')).toBeTruthy();
  });

  it('shows tools/list (never [NER]) for a tool_manifest_changed enrichment', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.detection_enrichment',
          category: 'tool_manifest_changed',
          severity: 'high',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('tools/list')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });

  it('shows [content] for inline content enrichments (wrapper inbound and Claude Code alike)', () => {
    render(
      <DetectionRow
        row={row({ type: 'mcp.detection_enrichment', category: 'credential_detected', severity: 'critical' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('[content]')).toBeTruthy();
    cleanup();
    render(
      <DetectionRow
        row={row({
          type: 'mcp.detection_enrichment',
          category: 'data_export_warning',
          source: 'claude-code',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('[content]')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });
});

describe('DetectionRow — SOURCE cell', () => {
  // The cell says what the Source chip says: one function names both.
  it('a catalog connector reads its catalog name', () => {
    render(<DetectionRow row={row({ mcp: 'drive' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Google Drive')).toBeTruthy();
  });

  it('a hand-wrapped server keeps the name it was wrapped with', () => {
    render(<DetectionRow row={row({ mcp: 'xcg-toy' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('xcg-toy')).toBeTruthy();
  });

  it("Claude Code's own tools read Claude Code", () => {
    render(
      <DetectionRow
        row={row({ mcp: 'claude-code', source: 'claude-code', type: 'mcp.request', toolName: 'Bash', method: 'tools/call' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
  });

  it('Claude Code calling an MCP tool: SOURCE plain "Claude Code", TOOL the tool alone', () => {
    render(
      <DetectionRow
        row={row({ mcp: 'notion', source: 'claude-code', type: 'mcp.request', toolName: 'notion-fetch', method: 'tools/call' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('Claude Code')).toBeTruthy();
    // No pill of any kind in SOURCE — neither the old CC one nor a server one.
    expect(screen.queryByText('CC')).toBeNull();
    // The server is named in the panel ("server: Notion"), not in the row.
    const tool = screen.getByText('notion-fetch');
    expect(tool.getAttribute('title')).toBe('mcp__notion__notion-fetch');
    expect(screen.queryByText(/Notion/)).toBeNull();
  });

  it('a Desktop connector row keeps its tool name, with no tooltip', () => {
    render(
      <DetectionRow
        row={row({ mcp: 'notion', source: 'gateway', type: 'mcp.request', toolName: 'search', method: 'tools/call' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('search').getAttribute('title')).toBeNull();
  });
});

describe('DetectionRow — severity of normal activity', () => {
  // The engine writes `low` on every baseline line; the row reads the
  // category and shows NONE — the bottom of the scale, a pill like the rest.
  it('a tool call that matched nothing reads NONE, not LOW', () => {
    render(
      <DetectionRow
        row={row({ type: 'mcp.request', category: 'tool_call_allowed', severity: 'low', toolName: 'search', method: 'tools/call' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('NONE')).toBeTruthy();
    expect(screen.queryByText('LOW')).toBeNull();
  });

  it('a protocol call reads NONE too', () => {
    render(
      <DetectionRow
        row={row({ type: 'mcp.request', category: 'tool_call_allowed', severity: 'low', method: 'initialize' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('NONE')).toBeTruthy();
  });

  it('a real LOW finding keeps its pill', () => {
    render(<DetectionRow row={row({ category: 'pii_detected', severity: 'low' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('LOW')).toBeTruthy();
  });
});

describe('DetectionRow — paired badge (frente 3)', () => {
  it('shows the pill with the hook title on a paired wrapper row (no CC badge needed)', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.request',
          category: 'tool_call_allowed',
          toolName: 'echo',
          method: 'tools/call',
          pairedSource: 'cc-hook',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    const pill = screen.getByTestId('paired-badge');
    expect(pill.getAttribute('title')).toBe('Also recorded by the Claude Code hook');
    // Paired wrapper row: the pill shows on its own.
    expect(screen.queryByText('CC')).toBeNull();
  });

  it('no pill on rows without pairedSource', () => {
    render(<DetectionRow row={row()} selected={false} onClick={() => {}} />);
    expect(screen.queryByTestId('paired-badge')).toBeNull();
  });
});

describe('Detections CATEGORY_OPTIONS', () => {
  // INVERTED on 24/09. It used to assert the opposite — that
  // tool_manifest_changed was filtered IN by default — and the inversion is
  // the product decision, not a test fix: manifest changes moved to their own
  // tab, where a change with no finding is a fact instead of a row graded
  // medium so it could be seen at all.
  it('excludes tool_manifest_changed — manifest changes live in MCP changes', () => {
    expect(CATEGORY_OPTIONS).not.toContain('tool_manifest_changed');
    expect(CATEGORY_OPTIONS).toHaveLength(7);
  });

  it('the exclusion is what filters them out, not a second rule', () => {
    // The filter ships `categories`; a category no option lists can never be
    // selected, so those events never match — historical ones included. If a
    // future edit puts it back in this list, manifest rows silently reappear
    // in Detections, which is what this asserts against.
    expect(CATEGORY_OPTIONS.includes('tool_manifest_changed' as (typeof CATEGORY_OPTIONS)[number])).toBe(
      false,
    );
  });
});
