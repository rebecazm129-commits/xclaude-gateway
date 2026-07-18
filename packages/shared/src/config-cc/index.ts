// Public surface of @xcg/shared/config-cc — Claude Code (CLI) config: scope
// model, tolerant readers, entry classification (F2.1a), plan + pure apply
// composing config/transform's wrapEntry/unwrapEntry (F2.1b). Still no disk
// writes: the real write path (freshness check + tmp/rename + post-write
// verification) lands in F2.1c. Same composition pattern as
// ../config/index.ts: @xcg/proxy and apps/desktop both consume this module
// without duplication.

export {
  claudeCodeUserConfigPath,
  projectMcpJsonPath,
  projectSettingsLocalPath,
  resolveScopeFiles,
} from './scopes.js';
export type { CcScope, ScopeFiles, ScopeTarget } from './scopes.js';
export { readMcpJson, readSettingsLocal } from './parser.js';
export { classifyEntries } from './classify.js';
export { computePlan } from './plan.js';
export type { CcIntent, CcPlan, CcPlanAction, CcSkipReason } from './plan.js';
export { applyPlan } from './apply.js';
export type {
  CcClassifiedEntry,
  CcEntryStatus,
  CcFileError,
  CcGatingResult,
  CcMcpJsonResult,
  CcServerEntry,
  CcUnsupportedReason,
} from './types.js';
