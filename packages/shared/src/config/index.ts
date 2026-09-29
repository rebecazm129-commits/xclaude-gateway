// Public surface of @xcg/shared/config — re-exports the read-only parser,
// the pure transform helpers, and the public types. Both @xcg/proxy
// (CLI: xcg-config) and apps/desktop (Setup UI in F5+) compose from
// this same module without duplication. See install.ts header for the
// analogous pattern with symlink helpers.

export { isAlreadyWrapped, isSafeRemoteName, parseConfig } from './parser.js';
export { toConnectors } from './connectors.js';
export { launchReference } from './launch-reference.js';
export type { Connector } from './connectors.js';
export { addRemoteToConfig, applyWrap, isHttpUrl, removeRemoteFromConfig, replaceRemoteInConfig, unwrap } from './transform.js';
export type { AddRemoteToConfigResult, RemoveRemoteFromConfigResult } from './transform.js';
export { CLAUDE_DESKTOP_CONFIG_PATH, STABLE_XCG_PROXY_PATH, xcgDataDir } from './paths.js';
export { writeAtomic } from './io.js';
export type { WriteAtomicError, WriteAtomicResult } from './io.js';
export {
  CCHOOK_MARKER,
  CCHOOK_EVENTS,
  CCHOOK_EVENT_ARG_EVENTS,
  CCHOOK_LAUNCH_SCRIPT,
  ELICITATION_EVENTS,
  ELICITATION_MIN_CLAUDE_CODE,
  buildCchookHookEntry,
  cchookEventsFor,
  cchookInstallSnippet,
  cchookUpdateSnippet,
  checkCchookHooks,
  compareVersions,
  fixableCchookIssues,
  mergeCchookHooks,
  removeCchookHooks,
  updateCchookHooks,
} from './claude-code-hooks.js';
export type {
  CchookEvent,
  CchookEventsOption,
  CchookHookEntry,
  CchookHooksSnippet,
  CchookHookIssue,
  CchookHookProblem,
  CchookHooksCheck,
  CchookHooksResult,
} from './claude-code-hooks.js';
export type {
  AddRemoteOk,
  AddRemoteResult,
  ClaudeConfig,
  ConnectOk,
  ConnectResult,
  EntryTransport,
  InstallOk,
  InstallResult,
  IpcConfigEntry,
  IpcConfigError,
  IpcConfigSummary,
  IsConnectedOk,
  IsConnectedResult,
  LaunchReference,
  McpEntry,
  ParseError,
  ParseResult,
  RemoveRemoteOk,
  RemoveRemoteResult,
  SkipReason,
  StatusOk,
  StatusResult,
  UninstallOk,
  UninstallResult,
  WrapPlan,
  WrapPlanEntry,
} from './types.js';
