// How a Claude Code call to an MCP tool is named: the tool's own name in TOOL,
// the connector by its visible name ("via Notion", "server: Notion"), and
// mcp__notion__notion-fetch in the panel and on hover. Everything
// else — native tools, a Desktop connector's own traffic — is left alone.

import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_LABELS,
  calledServerLabel,
  displayToolName,
  rawToolName,
  sourceLabel,
  splitRawToolName,
} from '../../src/shared/tool-names.js';
import { CATALOG } from '../../src/renderer/components/AddConnectorModal.js';

describe('splitRawToolName — at "__", never at "_"', () => {
  it('keeps underscores in the server name', () => {
    expect(splitRawToolName('mcp__claude_ai_Notion__notion_search')).toEqual({
      server: 'claude_ai_Notion',
      tool: 'notion_search',
    });
  });

  it('splits at the FIRST "__" after the prefix; the tool keeps any of its own', () => {
    expect(splitRawToolName('mcp__srv__tool__extra')).toEqual({ server: 'srv', tool: 'tool__extra' });
  });

  it('keeps hyphens', () => {
    expect(splitRawToolName('mcp__spike-fs__list_directory')).toEqual({
      server: 'spike-fs',
      tool: 'list_directory',
    });
  });

  it('is null for a native tool and for a single underscore', () => {
    expect(splitRawToolName('Bash')).toBeNull();
    expect(splitRawToolName('mcp_notion_search')).toBeNull();
  });
});

describe('displayToolName / calledServerLabel / rawToolName', () => {
  const cc = (mcp: string, toolName: string) => ({ source: 'claude-code' as const, mcp, toolName });

  it('TOOL is the tool alone; the server goes by its catalog name', () => {
    expect(displayToolName(cc('notion', 'notion-fetch'))).toBe('notion-fetch');
    expect(calledServerLabel(cc('notion', 'notion-fetch'))).toBe('Notion');
    expect(calledServerLabel(cc('drive', 'read_file'))).toBe('Google Drive');
    expect(rawToolName(cc('notion', 'notion-fetch'))).toBe('mcp__notion__notion-fetch');
  });

  it('a server the catalog does not list keeps its name, underscores and all', () => {
    expect(displayToolName(cc('local_fs_tools', 'read_dir'))).toBe('read_dir');
    expect(calledServerLabel(cc('local_fs_tools', 'read_dir'))).toBe('local_fs_tools');
    expect(rawToolName(cc('local_fs_tools', 'read_dir'))).toBe('mcp__local_fs_tools__read_dir');
  });

  it('a name that still arrives raw is split by the same rule', () => {
    const row = cc('claude-code', 'mcp__claude_ai_Notion__notion_search');
    expect(displayToolName(row)).toBe('notion_search');
    expect(calledServerLabel(row)).toBe('Notion');
    expect(rawToolName(row)).toBe('mcp__claude_ai_Notion__notion_search');
  });

  it('native Claude Code tools are untouched', () => {
    for (const t of ['Bash', 'Edit', 'Read', 'WebFetch']) {
      expect(displayToolName(cc('claude-code', t))).toBe(t);
      expect(calledServerLabel(cc('claude-code', t))).toBeNull();
      expect(rawToolName(cc('claude-code', t))).toBe(t);
    }
  });

  it("a Desktop connector's own rows are untouched", () => {
    const row = { source: 'gateway' as const, mcp: 'notion', toolName: 'search' };
    expect(displayToolName(row)).toBe('search');
    expect(calledServerLabel(row)).toBeNull();
    expect(rawToolName(row)).toBe('search');
  });

  it('no tool name, nothing to show', () => {
    expect(displayToolName({ source: 'claude-code', mcp: 'notion' })).toBeUndefined();
  });
});

describe('Claude.ai connectors (claude_ai_<Service>)', () => {
  const cc = (mcp: string, toolName: string) => ({ source: 'claude-code' as const, mcp, toolName });

  it('drop the prefix and take the catalog name', () => {
    expect(calledServerLabel(cc('claude_ai_Linear', 'list_issues'))).toBe('Linear');
    expect(calledServerLabel(cc('claude_ai_Notion', 'notion-fetch'))).toBe('Notion');
    expect(displayToolName(cc('claude_ai_Linear', 'list_issues'))).toBe('list_issues');
  });

  it('match a multi-word catalog name', () => {
    expect(calledServerLabel(cc('claude_ai_Google_Drive', 'search'))).toBe('Google Drive');
  });

  it('a service the catalog does not list shows without the prefix', () => {
    expect(calledServerLabel(cc('claude_ai_Figma', 'get_file'))).toBe('Figma');
  });

  it('the raw name keeps the prefix — for the tooltip, the panel and search', () => {
    expect(rawToolName(cc('claude_ai_Linear', 'list_issues'))).toBe('mcp__claude_ai_Linear__list_issues');
  });

  it('only the exact prefix is dropped', () => {
    expect(calledServerLabel(cc('claude_aiLinear', 'x'))).toBe('claude_aiLinear');
    expect(calledServerLabel(cc('claude_ai_', 'x'))).toBe('claude_ai_');
  });
});

describe('connector names', () => {
  it('every catalog card is named the same in the SOURCE column', () => {
    // The card label and CONNECTOR_LABELS are two literals; this is what keeps
    // a renamed card from leaving the column on the old name.
    for (const entry of CATALOG) {
      if (entry.name === 'claude-code') {
        expect(sourceLabel(entry.name)).toBe(entry.label);
        continue;
      }
      expect(CONNECTOR_LABELS[entry.name], entry.name).toBe(entry.label);
    }
  });

  it('an unknown source keeps its own name', () => {
    expect(sourceLabel('xcg-toy')).toBe('xcg-toy');
  });
});
