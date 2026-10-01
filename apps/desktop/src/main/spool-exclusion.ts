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
import { mkdirSync, statSync } from 'node:fs';

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

/**
 * Keeps the exclusion when the spool folder is recreated. The exclusion is an
 * attribute of the folder itself, so a spool deleted while the app runs (by
 * hand, a cleaner, a wiped data folder) comes back from the hook WITHOUT it —
 * and the hook must not fix that (it stays a minimal, silent capturer). The
 * app remembers the inode of the folder it excluded; on each ingest cycle a
 * different inode means a different folder, which is excluded again. One
 * stat per cycle; tmutil runs only on a change. A failure is logged by
 * excludeSpoolFromTimeMachine and changes nothing else — the new inode is
 * remembered either way, so a failing tmutil is not retried every 15 s.
 */
export interface SpoolExclusionGuard {
  /** At app start: exclude, then remember the folder's inode. */
  start(): Promise<ExclusionOutcome>;
  /** On each ingest cycle: exclude again only if the folder changed. */
  check(): Promise<void>;
}

export function createSpoolExclusionGuard(
  deps: {
    spoolDir?: string;
    exclude?: () => Promise<ExclusionOutcome>;
    inodeOf?: (dir: string) => number | null;
  } = {},
): SpoolExclusionGuard {
  const dir = deps.spoolDir ?? cchookSpoolDir();
  const exclude = deps.exclude ?? (() => excludeSpoolFromTimeMachine({ spoolDir: dir }));
  const inodeOf =
    deps.inodeOf ??
    ((d: string): number | null => {
      try {
        return statSync(d).ino;
      } catch {
        return null;
      }
    });
  let excludedIno: number | null = null;
  let running = false;
  return {
    async start() {
      const outcome = await exclude();
      excludedIno = inodeOf(dir);
      return outcome;
    },
    async check() {
      if (running) return;
      const ino = inodeOf(dir);
      // Gone: nothing to exclude yet; the hook will recreate it and the next
      // cycle sees a new inode.
      if (ino === null || ino === excludedIno) return;
      running = true;
      try {
        await exclude();
        excludedIno = inodeOf(dir);
      } finally {
        running = false;
      }
    },
  };
}
