// Recovery marker writer — the ONLY desktop→wrappers-JSONL write path.
// After a successful reconnect, the desktop appends one app.connector_recovered
// envelope so readAudit can clear a stale re-login alert without waiting for the
// next Claude Desktop restart (until now the only signal that superseded a past
// oauth_failed was fresh mcp.* traffic, which only resumes on restart).
// Best-effort, append-only: mirrors the proxy JsonlWriter durability model
// (page-cache backed, 0o600 file / 0o700 dir), but writes to a stable shared
// file rather than a per-session one.

import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_WRAPPERS_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'xCLAUDE Gateway',
  'wrappers',
);

// Stable, desktop-owned file. Distinct from the proxy's ${session}.jsonl so the
// two never contend on one fd. readAudit scans every *.jsonl in the dir.
export const APP_EVENTS_FILENAME = 'app-events.jsonl';

// Event type readAudit consumes as a positive "later signal" (parallel to live
// mcp.* traffic) that supersedes a prior oauth_failed for the same mcp.
export const CONNECTOR_RECOVERED_TYPE = 'app.connector_recovered';

// Appends one recovery marker for `mcp` (the connector name — the key readAudit
// indexes authAlerts by). Never throws: a write failure is logged and swallowed
// (the reconnect already succeeded, so the worst case is the alert lingers
// exactly as it does today).
export function writeConnectorRecovered(
  mcp: string,
  dir: string = DEFAULT_WRAPPERS_DIR,
): void {
  const envelope = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    session: 'desktop',
    mcp,
    type: CONNECTOR_RECOVERED_TYPE,
  };
  const filePath = join(dir, APP_EVENTS_FILENAME);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(filePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`writeConnectorRecovered: failed to append ${filePath}:`, err);
  }
}
