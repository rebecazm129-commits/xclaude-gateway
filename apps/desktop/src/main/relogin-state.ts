// Persisted record of which re-login failures have already been announced.
//
// Its OWN file, deliberately not settings.json: this is derived state rewritten
// on the 60s notifier cadence, while settings.json holds user-facing config. A
// corrupt write here must never cost someone their retention setting.
//
// Shape: mcp → the lastFailureTs already announced for it. Keying on the
// FAILURE rather than on the connector is the whole point. The previous state
// was a Set in process memory whose first pass seeded silently
// (relogin-notify.ts), so a failure that began while the app was closed was
// adopted without a word and never announced again — that is how the 08-15/09
// stripe outage ran seven days without a single notification. With the
// timestamp as the key: a cold start announces what it has not seen, a restart
// does not repeat it, and a NEW failure after a recovery announces again.
//
// Best-effort throughout, and the degradation direction is chosen: an
// unreadable file reads as empty, which makes the next pass NOTIFY. A lost
// state file costs a duplicate notification, never a missed one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeAtomic } from '@xcg/shared/config';

export const RELOGIN_STATE_FILENAME = 'relogin-notified.json';

/** mcp → the lastFailureTs already announced for that connector. */
export type NotifiedMap = Map<string, string>;

export function reloginStatePath(baseDir: string): string {
  return join(baseDir, RELOGIN_STATE_FILENAME);
}

/** Never throws. Absent, unparseable or malformed → empty map (= notify). */
export function readNotified(baseDir: string): NotifiedMap {
  let raw: string;
  try {
    raw = readFileSync(reloginStatePath(baseDir), 'utf8');
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rec = (parsed as { notified?: unknown } | null)?.notified;
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return new Map();
    const out: NotifiedMap = new Map();
    for (const [mcp, ts] of Object.entries(rec as Record<string, unknown>)) {
      if (typeof ts === 'string' && ts !== '') out.set(mcp, ts);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Never throws. A write failure is logged and swallowed: the in-memory map
 *  still suppresses repeats for this run, and the worst case after a restart is
 *  one duplicate notification. */
export function writeNotified(notified: NotifiedMap, baseDir: string): void {
  const path = reloginStatePath(baseDir);
  // Sorted so the file is stable across runs and diffable by hand.
  const value = { v: 1, notified: Object.fromEntries([...notified.entries()].sort()) };
  try {
    if (!existsSync(path)) {
      // writeAtomic stats the target first, so the first write has to seed it
      // (same reason as cchook-ingester's persistJson).
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      return;
    }
    // backup:false — derived state we own; a .bak next to it would be noise.
    const res = writeAtomic(path, value, { backup: false });
    if (!res.ok) {
      console.error(`relogin-state: failed to persist ${path}: ${res.error.kind}`);
    }
  } catch (err) {
    console.error(`relogin-state: failed to persist ${path}:`, err);
  }
}
