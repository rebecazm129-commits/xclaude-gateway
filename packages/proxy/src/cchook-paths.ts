// Canonical path for the Claude Code hook spool. Single source of the route,
// mirroring refreshLockPath (refresh-lock.ts): a helper exported here and
// composed by every consumer, never re-joined ad hoc. The spool lives OUTSIDE
// wrappers/ on purpose — the AuditStore/retention readdir scan of wrappers/ is
// flat and must never see these files (F1.0-P3).

import { join } from 'node:path';

// The LIGHT module, not '@xcg/shared/config': this runs inside the hook, which
// must stay small and start fast.
import { xcgDataDir } from '@xcg/shared/config/data-dir';

export function cchookSpoolDir(): string {
  return join(xcgDataDir(), 'claude-code', 'spool');
}
