import { describe, expect, it } from 'vitest';

import { toConnectors } from '../../src/config/connectors.js';
import type { IpcConfigEntry } from '../../src/config/types.js';

describe('toConnectors — pure IpcConfigEntry → Connector mapping (Connectors Fase 1)', () => {
  it('already-wrapped http → remote, audited, endpoint = url', () => {
    const entries: IpcConfigEntry[] = [
      {
        kind: 'skipped',
        name: 'linear',
        reason: 'already-wrapped',
        transport: 'http',
        endpoint: 'https://mcp.linear.app/mcp',
      },
    ];
    expect(toConnectors(entries)).toEqual([
      { name: 'linear', type: 'remote', status: 'audited', endpoint: 'https://mcp.linear.app/mcp' },
    ]);
  });

  it('already-wrapped stdio → local, audited, endpoint = wrapped command', () => {
    const entries: IpcConfigEntry[] = [
      {
        kind: 'skipped',
        name: 'filesystem',
        reason: 'already-wrapped',
        transport: 'stdio',
        endpoint: '/usr/local/bin/npx',
      },
    ];
    expect(toConnectors(entries)).toEqual([
      { name: 'filesystem', type: 'local', status: 'audited', endpoint: '/usr/local/bin/npx' },
    ]);
  });

  it('wrappable → local, not-audited, endpoint = command', () => {
    const entries: IpcConfigEntry[] = [
      { kind: 'wrappable', name: 'custom', transport: 'stdio', endpoint: 'node' },
    ];
    expect(toConnectors(entries)).toEqual([
      { name: 'custom', type: 'local', status: 'not-audited', endpoint: 'node' },
    ]);
  });

  it('no-command → unknown, unsupported, endpoint null', () => {
    const entries: IpcConfigEntry[] = [
      { kind: 'skipped', name: 'weird', reason: 'no-command', transport: null, endpoint: null },
    ];
    expect(toConnectors(entries)).toEqual([
      { name: 'weird', type: 'unknown', status: 'unsupported', endpoint: null },
    ]);
  });

  it('tolerates entries without the optional enrichment fields (old IPC shape)', () => {
    const entries: IpcConfigEntry[] = [
      { kind: 'wrappable', name: 'bare' },
      { kind: 'skipped', name: 'wrapped', reason: 'already-wrapped' },
    ];
    expect(toConnectors(entries)).toEqual([
      { name: 'bare', type: 'local', status: 'not-audited', endpoint: null },
      { name: 'wrapped', type: 'unknown', status: 'audited', endpoint: null },
    ]);
  });
});
