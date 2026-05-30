// Public surface of @xcg/shared/config — re-exports the read-only parser,
// the pure transform helpers, and the public types. Both @xcg/proxy
// (CLI: xcg-config) and apps/desktop (Setup UI in F5+) compose from
// this same module without duplication. See install.ts header for the
// analogous pattern with symlink helpers.

export { isAlreadyWrapped, isSafeRemoteName, parseConfig } from './parser.js';
export { addRemoteToConfig, applyWrap, removeRemoteFromConfig, unwrap } from './transform.js';
export type { AddRemoteToConfigResult, RemoveRemoteFromConfigResult } from './transform.js';
export { CLAUDE_DESKTOP_CONFIG_PATH, STABLE_XCG_PROXY_PATH } from './paths.js';
export { writeAtomic } from './io.js';
export type { WriteAtomicError, WriteAtomicResult } from './io.js';
export type {
  ClaudeConfig,
  InstallOk,
  InstallResult,
  IpcConfigEntry,
  IpcConfigError,
  IpcConfigSummary,
  McpEntry,
  ParseError,
  ParseResult,
  SkipReason,
  StatusOk,
  StatusResult,
  UninstallOk,
  UninstallResult,
  WrapPlan,
  WrapPlanEntry,
} from './types.js';
