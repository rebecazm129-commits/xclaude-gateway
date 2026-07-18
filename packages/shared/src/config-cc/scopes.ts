// Scope model for Claude Code (CLI) config — F2.1a. Claude Code spreads its
// MCP config over three scopes (`claude mcp add --scope ...`); ScopeTarget is
// the central abstraction of F2.1: every read/classify (and, in F2.1b, every
// write) is addressed to one of them. Fixed by spike 3 (2026-07-18, fixtures
// in tests/fixtures/config-cc/):
//   user    → ~/.claude.json, top-level `mcpServers`.
//   local   → ~/.claude.json, `projects[<projectDir>].mcpServers` (the same
//             projects entry also carries enabled/disabledMcpjsonServers and
//             hasTrustDialogAccepted).
//   project → <projectDir>/.mcp.json (shared, committed), gated per-user by
//             <projectDir>/.claude/settings.local.json.
// Pure path resolution, no IO — the tolerant readers live in ./parser.ts.

import { homedir } from 'node:os';
import { join } from 'node:path';

export type CcScope = 'user' | 'local' | 'project';

// WHERE a config operation points. user needs no project; local and project
// are relative to a project directory (absolute path, exactly as Claude Code
// keys it in ~/.claude.json's `projects` map).
export type ScopeTarget =
  | { scope: 'user' }
  | { scope: 'local'; projectDir: string }
  | { scope: 'project'; projectDir: string };

// Physical files backing a ScopeTarget. `entriesKeyPath` is the key path
// inside entriesPath down to the mcpServers record — user/project hold it at
// the top level, local holds it nested under projects[<dir>].
export interface ScopeFiles {
  scope: CcScope;
  entriesPath: string;
  entriesKeyPath: readonly string[];
  // Project scope only: the per-user gating file carrying
  // enabledMcpjsonServers / disabledMcpjsonServers (spike 3 pasos 6/B).
  gatingPath?: string;
}

// Claude Code's user-level config file. Unlike Claude Desktop's config
// (config/paths.ts) this is not macOS-specific: ~/.claude.json on every
// platform. homeDir is injectable for tests; production callers omit it.
export function claudeCodeUserConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, '.claude.json');
}

// The project-shared MCP manifest. Absence is valid (≡ zero servers).
export function projectMcpJsonPath(projectDir: string): string {
  return join(projectDir, '.mcp.json');
}

// The per-user approval state for a project's .mcp.json servers. Absence is
// valid (≡ no decision yet; every entry is pending).
export function projectSettingsLocalPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json');
}

export function resolveScopeFiles(target: ScopeTarget, homeDir: string = homedir()): ScopeFiles {
  switch (target.scope) {
    case 'user':
      return {
        scope: 'user',
        entriesPath: claudeCodeUserConfigPath(homeDir),
        entriesKeyPath: ['mcpServers'],
      };
    case 'local':
      return {
        scope: 'local',
        entriesPath: claudeCodeUserConfigPath(homeDir),
        entriesKeyPath: ['projects', target.projectDir, 'mcpServers'],
      };
    case 'project':
      return {
        scope: 'project',
        entriesPath: projectMcpJsonPath(target.projectDir),
        entriesKeyPath: ['mcpServers'],
        gatingPath: projectSettingsLocalPath(target.projectDir),
      };
  }
}
