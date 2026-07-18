// Public surface of @xcg/shared/config-cc — Claude Code (CLI) config: scope
// model, tolerant readers, entry classification (F2.1a). Read-only for now;
// the write path (wrap/unwrap composing config/transform's helpers) lands in
// F2.1b. Same composition pattern as ../config/index.ts: @xcg/proxy and
// apps/desktop both consume this module without duplication.

export {
  claudeCodeUserConfigPath,
  projectMcpJsonPath,
  projectSettingsLocalPath,
  resolveScopeFiles,
} from './scopes.js';
export type { CcScope, ScopeFiles, ScopeTarget } from './scopes.js';
export { readMcpJson, readSettingsLocal } from './parser.js';
export { classifyEntries } from './classify.js';
export type {
  CcClassifiedEntry,
  CcEntryStatus,
  CcFileError,
  CcGatingResult,
  CcMcpJsonResult,
  CcServerEntry,
  CcUnsupportedReason,
} from './types.js';
