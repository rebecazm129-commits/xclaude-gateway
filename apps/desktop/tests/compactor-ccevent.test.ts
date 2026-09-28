// The compactor's Claude Code terminal still fires on a SessionEnd line as the
// ingest now writes it (whitelisted fields, no raw payload), and a SessionStart
// line still does not.

import { describe, expect, it } from 'vitest';

import { parseHookPayload, synthesize } from '@xcg/proxy/cchook-ingest';

import { isCandidateFile } from '../src/main/compactor.js';

const line = (payload: Record<string, unknown>): string => {
  const ctx = { sessionUlid: '01M3TEST0000000000000000AA', captureTimeMs: 1_750_000_000_000, nextId: () => 'ID-1' };
  return `${JSON.stringify(synthesize(parseHookPayload(JSON.stringify(payload)), ctx)[0])}\n`;
};

describe('compactor terminal on the new cc.event shape', () => {
  const NOW = Date.parse('2026-09-28T12:00:00.000Z');

  it('SessionEnd is a terminal', () => {
    const content = line({ hook_event_name: 'SessionEnd', session_id: 'cc', reason: 'clear', cwd: '/x' });
    expect(isCandidateFile(content, NOW, NOW)).toBe(true);
  });

  it('SessionStart is not (silence rule still applies)', () => {
    const content = line({ hook_event_name: 'SessionStart', session_id: 'cc', source: 'startup' });
    expect(isCandidateFile(content, NOW, NOW)).toBe(false);
  });
});
