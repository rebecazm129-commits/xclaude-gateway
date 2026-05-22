// Public surface of @xcg/shared/config — re-exports the read-only parser,
// the pure transform helpers, and the public types. Both @xcg/proxy
// (CLI: xcg-config) and apps/desktop (Setup UI in F5+) compose from
// this same module without duplication. See install.ts header for the
// analogous pattern with symlink helpers.

export { isAlreadyWrapped, parseConfig } from './parser.js';
export { applyWrap, unwrap } from './transform.js';
export type {
  ClaudeConfig,
  McpEntry,
  ParseError,
  ParseResult,
  SkipReason,
  WrapPlan,
  WrapPlanEntry,
} from './types.js';
