// Keep the Claude Code spool out of Time Machine backups.
//
// The spool holds hook events between capture and ingestion — seconds
// normally, hours while the app is closed. They are masked before they are
// written (xcg-cchook, cchook-spool.ts), but a backup would keep them long
// after the app deleted them. So the app marks the folder as excluded:
// `tmutil addexclusion` without -p sets the exclusion as an attribute of the
// folder itself (no admin rights), then `tmutil isexcluded` confirms it.
//
// The APP does this, never the hook: the hook must stay a minimal, silent
// capturer. Local APFS snapshots do not honour exclusions — SECURITY.md says
// so. A failure is logged and changes nothing else.

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { cchookSpoolDir } from '@xcg/proxy/cchook-ingest';

export type ExclusionOutcome = 'excluded' | 'failed' | 'skipped';

export interface ExclusionDeps {
  spoolDir?: string;
  platform?: NodeJS.Platform;
  mkdir?: (dir: string) => void;
  /** Runs a command, resolving with its stdout. */
  run?: (cmd: string, args: readonly string[]) => Promise<string>;
  log?: (message: string) => void;
}

const TMUTIL = '/usr/bin/tmutil';

function runCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Create the spool folder if needed (the app, not only the hook, creates it)
 * and exclude it from Time Machine, verifying the result. Never throws.
 */
export async function excludeSpoolFromTimeMachine(deps: ExclusionDeps = {}): Promise<ExclusionOutcome> {
  const log = deps.log ?? ((m: string) => console.error(m));
  if ((deps.platform ?? process.platform) !== 'darwin') return 'skipped';
  const dir = deps.spoolDir ?? cchookSpoolDir();
  const run = deps.run ?? runCommand;
  try {
    (deps.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true })))(dir);
    await run(TMUTIL, ['addexclusion', dir]);
    const status = await run(TMUTIL, ['isexcluded', dir]);
    if (!status.includes('[Excluded]')) {
      log(`spool-exclusion: tmutil did not confirm the exclusion of ${dir}: ${status.trim()}`);
      return 'failed';
    }
    return 'excluded';
  } catch (err) {
    log(`spool-exclusion: could not exclude ${dir} from Time Machine: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}
