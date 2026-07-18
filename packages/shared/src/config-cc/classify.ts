// Entry classification for Claude Code project config — F2.1a. Pure: crosses
// the .mcp.json entries with the settings.local.json gating lists and states
// what each entry IS; it never mutates or writes. The F2.1b plan consumes
// this to decide what the wrap path may touch.

import type {
  CcClassifiedEntry,
  CcServerEntry,
  CcUnsupportedReason,
} from './types.js';

// Transport gate fixed by the approved F2.1 design: http/sse entries are
// unsupported (the stdio wrap has nothing to exec). no-command covers
// malformed entries and url-without-type shapes the wrap could never target
// — same spirit as config/parser.ts's 'no-command' skip.
function unsupportedReason(entry: CcServerEntry): CcUnsupportedReason | null {
  if (entry.type === 'http') return 'type-http';
  if (entry.type === 'sse') return 'type-sse';
  if (typeof entry.command !== 'string' || entry.command === '') return 'no-command';
  return null;
}

// Classify every entry. Precedences, most defensive first:
// - unsupported wins over gating: spike 3 paso 6 shows Claude Code happily
//   lists an http server in enabledMcpjsonServers, but enabled-by-the-user
//   does not make it actionable by the gateway.
// - disabled wins over enabled: spike 3 never observed both keys at once
//   (approve-all writes only enabled, reject-all only disabled), but a
//   hand-edited file could list a name in both — fail safe, treat as
//   rejected rather than acting on it.
// - neither list → pending (no decision yet; also the absent-file state).
export function classifyEntries(
  servers: Readonly<Record<string, CcServerEntry>>,
  gating: { enabled: readonly string[]; disabled: readonly string[] },
): readonly CcClassifiedEntry[] {
  return Object.entries(servers).map(([name, entry]): CcClassifiedEntry => {
    const reason = unsupportedReason(entry);
    if (reason !== null) return { status: 'unsupported', name, reason, entry };
    if (gating.disabled.includes(name)) return { status: 'disabled', name, entry };
    if (gating.enabled.includes(name)) return { status: 'enabled', name, entry };
    return { status: 'pending', name, entry };
  });
}
