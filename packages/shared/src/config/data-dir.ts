// xCLAUDE Gateway's data folder, alone in its module: the Claude Code hook
// imports it, and the hook must stay small and start fast — nothing here but
// node:os and node:path. paths.ts re-exports it for everyone else.

import { homedir } from 'node:os';
import { join } from 'node:path';

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
