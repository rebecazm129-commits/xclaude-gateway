import { describe, expect, it } from 'vitest';

import { resolveScopeFiles } from '../../src/config-cc/scopes.js';

describe('resolveScopeFiles — ScopeTarget → physical files (F2.1a)', () => {
  const home = '/Users/user';
  const projectDir = '/Users/user/code/proj';

  it('user: ~/.claude.json, top-level mcpServers, no gating', () => {
    expect(resolveScopeFiles({ scope: 'user' }, home)).toEqual({
      scope: 'user',
      entriesPath: '/Users/user/.claude.json',
      entriesKeyPath: ['mcpServers'],
    });
  });

  it('local: same ~/.claude.json, nested under projects[<dir>], no gating', () => {
    expect(resolveScopeFiles({ scope: 'local', projectDir }, home)).toEqual({
      scope: 'local',
      entriesPath: '/Users/user/.claude.json',
      entriesKeyPath: ['projects', projectDir, 'mcpServers'],
    });
  });

  it('project: <dir>/.mcp.json gated by <dir>/.claude/settings.local.json', () => {
    expect(resolveScopeFiles({ scope: 'project', projectDir }, home)).toEqual({
      scope: 'project',
      entriesPath: '/Users/user/code/proj/.mcp.json',
      entriesKeyPath: ['mcpServers'],
      gatingPath: '/Users/user/code/proj/.claude/settings.local.json',
    });
  });

  it('defaults homeDir to the real home when omitted', () => {
    const r = resolveScopeFiles({ scope: 'user' });
    expect(r.entriesPath.endsWith('/.claude.json')).toBe(true);
  });
});
