// Connector model — pure view over IpcConfigEntry for the Connectors UI
// (Setup→Connectors redesign). No IO, no IPC: just the mapping from the
// wrap-plan classification to "what is this and is it audited":
//   skipped/already-wrapped + transport http  → remote, audited
//   skipped/already-wrapped + transport stdio → local,  audited
//   wrappable (local, not wrapped yet)        → local,  not-audited
//   skipped/no-command (shape we can't bridge)→ unknown, unsupported
// endpoint carries through verbatim (remote url / wrapped command / command).

import type { IpcConfigEntry } from './types.js';

export interface Connector {
  name: string;
  type: 'remote' | 'local' | 'unknown';
  status: 'audited' | 'not-audited' | 'unsupported';
  endpoint: string | null;
}

export function toConnectors(entries: readonly IpcConfigEntry[]): Connector[] {
  return entries.map((e) => {
    if (e.kind === 'wrappable') {
      return { name: e.name, type: 'local', status: 'not-audited', endpoint: e.endpoint ?? null };
    }
    if (e.reason === 'already-wrapped') {
      return {
        name: e.name,
        type: e.transport === 'http' ? 'remote' : e.transport === 'stdio' ? 'local' : 'unknown',
        status: 'audited',
        endpoint: e.endpoint ?? null,
      };
    }
    // no-command: a shape the bridge can't represent (e.g. bare url entry).
    return { name: e.name, type: 'unknown', status: 'unsupported', endpoint: e.endpoint ?? null };
  });
}
