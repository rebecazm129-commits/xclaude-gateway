// Canonical paths for the xCLAUDE Gateway product on macOS.
// Imported by:
// - @xcg/proxy/src/config/cli.ts (CLI default for --config-path; default
//   xcgPath in resolveXcgPath when the bundle is packaged).
// - apps/desktop/src/main/index.ts (bootstrapStableSymlink target + the
//   IPC config handlers added in F5.1).
//
// These strings are macOS-specific and reflect Claude Desktop's default
// config location and the stable symlink that F3b bootstraps. Linux and
// Windows support, if added later, will introduce platform branches here.

import { homedir } from 'node:os';
import { join } from 'node:path';

// Canonical location of Claude Desktop's MCP config on macOS.
export const CLAUDE_DESKTOP_CONFIG_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);

/**
 * xCLAUDE Gateway's data folder: the audit trail (wrappers/), the connector
 * baselines (manifests/), the masking salt, the Claude Code spool, locks and
 * the stable bin/ symlinks. One function so nothing re-joins it by hand; the
 * home directory is a parameter so a detector can be tested against a fixed
 * one.
 */
export function xcgDataDir(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'xCLAUDE Gateway');
}

// Stable symlink that the .app bootstraps on first launch (F3b) and that
// the wrap plan references in claude_desktop_config.json. Survives moving
// or reinstalling the .app, so the wrap entry never points at a dead path.
export const STABLE_XCG_PROXY_PATH = join(xcgDataDir(), 'bin', 'xcg-proxy');
