// @vitest-environment jsdom
// TOOL and DETAILS in the Claude Code view, for a call to an MCP tool.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ClaudeCodeRow } from '../../src/renderer/components/ClaudeCodeRow.js';
import type { DetectionRowSlim } from '../../src/shared/types.js';

afterEach(cleanup);

const row = (over: Partial<DetectionRowSlim>): DetectionRowSlim => ({
  id: 'r',
  ts: '2026-09-24T11:00:00.000Z',
  mcp: 'claude-code',
  type: 'mcp.request',
  category: 'tool_call_allowed',
  severity: 'low',
  source: 'claude-code',
  method: 'tools/call',
  ...over,
});

describe('ClaudeCodeRow — TOOL', () => {
  it('an MCP call: the tool alone in TOOL (raw name on hover), "via Notion" in DETAILS', () => {
    render(
      <ClaudeCodeRow
        row={row({ mcp: 'notion', toolName: 'notion-fetch', argsSummary: 'page 123' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('notion-fetch').getAttribute('title')).toBe('mcp__notion__notion-fetch');
    expect(screen.getByText('via Notion')).toBeTruthy();
    expect(screen.getByText('page 123')).toBeTruthy();
  });

  it('with no arguments, DETAILS does not repeat the server after "via"', () => {
    render(<ClaudeCodeRow row={row({ mcp: 'notion', toolName: 'notion-fetch' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('via Notion').parentElement?.textContent).toBe('via Notion');
  });

  it('a Claude.ai connector drops its prefix; the raw name stays on hover', () => {
    render(
      <ClaudeCodeRow row={row({ mcp: 'claude_ai_Linear', toolName: 'list_issues' })} selected={false} onClick={() => {}} />,
    );
    expect(screen.getByText('list_issues').getAttribute('title')).toBe('mcp__claude_ai_Linear__list_issues');
    expect(screen.getByText('via Linear')).toBeTruthy();
  });

  it('a native tool is untouched, with no tooltip', () => {
    render(<ClaudeCodeRow row={row({ toolName: 'Bash' })} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Bash').getAttribute('title')).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
  });
});

describe('ClaudeCodeRow — elicitation', () => {
  const elicitRow = (over: Partial<DetectionRowSlim> = {}) =>
    row({
      mcp: 'spike-elicit',
      method: 'elicitation/create',
      category: 'protocol_tripwire',
      severity: 'medium',
      argsSummary: 'form · Please confirm',
      ...over,
    });

  it('TOOL reads "Server requested input", not the method', () => {
    render(<ClaudeCodeRow row={elicitRow()} selected={false} onClick={() => {}} />);
    expect(screen.getByText('Server requested input')).toBeTruthy();
    expect(screen.queryByText('elicitation/create')).toBeNull();
  });

  it('DETAILS: the action first, then mode and message', () => {
    for (const [action, text] of [
      ['accept', 'User accepted · form · Please confirm'],
      ['decline', 'User declined · form · Please confirm'],
      ['cancel', 'User cancelled · form · Please confirm'],
    ] as const) {
      render(<ClaudeCodeRow row={elicitRow({ elicitationAction: action })} selected={false} onClick={() => {}} />);
      expect(screen.getByText(text)).toBeTruthy();
      cleanup();
    }
  });

  it('DETAILS without an action has no prefix', () => {
    render(<ClaudeCodeRow row={elicitRow()} selected={false} onClick={() => {}} />);
    expect(screen.getByText('form · Please confirm')).toBeTruthy();
  });
});
