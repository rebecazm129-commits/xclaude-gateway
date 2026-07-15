// Canonical path for the Claude Code hook spool. Single source of the route,
// mirroring refreshLockPath (refresh-lock.ts): a helper exported here and
// composed by every consumer, never re-joined ad hoc. The spool lives OUTSIDE
// wrappers/ on purpose — the AuditStore/retention readdir scan of wrappers/ is
// flat and must never see these files (F1.0-P3).

import { homedir } from 'node:os';
import { join } from 'node:path';

export function cchookSpoolDir(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'xCLAUDE Gateway',
    'claude-code',
    'spool',
  );
}
