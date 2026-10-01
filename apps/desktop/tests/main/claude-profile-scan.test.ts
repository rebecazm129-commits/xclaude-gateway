// Best-effort detection of ~/.claude-* profiles without the xCLAUDE hook, over
// a real temporary home folder (directories, symlinks, unreadable files).

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CCHOOK_EVENTS, cchookInstallSnippet } from '@xcg/shared/config';

import {
  PROFILE_SCAN_TTL_MS,
  createProfileScanCache,
  findUnauditedClaudeProfiles,
} from '../../src/main/claude-profile-scan.js';

const EVENTS = CCHOOK_EVENTS;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xcg-profile-scan-'));
  // The audited profile, with our hook, and ~/.claude.json: never candidates.
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(cchookInstallSnippet(EVENTS)));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hooks: {} }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function profile(name: string, settings: unknown | string): void {
  mkdirSync(join(home, name));
  writeFileSync(join(home, name, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
}

const scan = () => findUnauditedClaudeProfiles(EVENTS, { home });

describe('findUnauditedClaudeProfiles', () => {
  it('a ~/.claude-* profile whose settings.json lacks our hook is a candidate, with the install snippet', () => {
    profile('.claude-work', { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    const found = scan();
    expect(found).toEqual([{ path: '~/.claude-work', snippet: JSON.stringify(cchookInstallSnippet(EVENTS), null, 2) }]);
  });

  it('a settings.json with no hooks section at all is a candidate too', () => {
    profile('.claude-personal', { theme: 'dark' });
    expect(scan().map((p) => p.path)).toEqual(['~/.claude-personal']);
  });

  it('a profile that already has our hook: nothing', () => {
    profile('.claude-work', cchookInstallSnippet(EVENTS));
    expect(scan()).toEqual([]);
  });

  it('a ~/.claude-* symlink to ~/.claude: nothing (it is the audited profile)', () => {
    symlinkSync(join(home, '.claude'), join(home, '.claude-alias'));
    expect(scan()).toEqual([]);
  });

  it('a settings.json that is a link to ~/.claude/settings.json: nothing', () => {
    mkdirSync(join(home, '.claude-link'));
    symlinkSync(join(home, '.claude', 'settings.json'), join(home, '.claude-link', 'settings.json'));
    expect(scan()).toEqual([]);
  });

  it('~/.claude and ~/.claude.json are never candidates, nor a .claude-* FILE, nor a dir without settings.json', () => {
    writeFileSync(join(home, '.claude-notes'), 'not a directory');
    mkdirSync(join(home, '.claude-empty'));
    expect(scan()).toEqual([]);
  });

  it('unreadable or unparseable settings.json does not break the scan and is skipped', () => {
    profile('.claude-broken', '{ not json');
    profile('.claude-locked', { theme: 'dark' });
    chmodSync(join(home, '.claude-locked', 'settings.json'), 0o000);
    profile('.claude-ok', { theme: 'dark' });
    try {
      expect(() => scan()).not.toThrow();
      expect(scan().map((p) => p.path)).toEqual(['~/.claude-ok']);
    } finally {
      chmodSync(join(home, '.claude-locked', 'settings.json'), 0o600);
    }
  });

  it('a home folder that cannot be listed: no candidates, no throw', () => {
    expect(findUnauditedClaudeProfiles(EVENTS, { home: join(home, 'does-not-exist') })).toEqual([]);
  });

  it('several candidates come back sorted', () => {
    profile('.claude-zeta', {});
    profile('.claude-alpha', {});
    expect(scan().map((p) => p.path)).toEqual(['~/.claude-alpha', '~/.claude-zeta']);
  });
});

describe('createProfileScanCache — not on every 2s poll', () => {
  const RESULT = [{ path: '~/.claude-work', snippet: '{}' }];
  function cache() {
    let t = 1_000_000;
    const scan = vi.fn(() => RESULT);
    const c = createProfileScanCache({ now: () => t, scan });
    return { c, scan, advance: (ms: number) => (t += ms) };
  }

  it('the 2s polls of one minute reuse a single scan', () => {
    const { c, scan, advance } = cache();
    for (let i = 0; i < 30; i++) {
      expect(c.get(EVENTS)).toBe(RESULT);
      advance(2_000);
    }
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('scans again once the result is 60s old', () => {
    const { c, scan, advance } = cache();
    c.get(EVENTS);
    advance(PROFILE_SCAN_TTL_MS - 1);
    c.get(EVENTS);
    expect(scan).toHaveBeenCalledTimes(1);
    advance(1);
    c.get(EVENTS);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('invalidate (opening the Claude Code tab) makes the next get scan', () => {
    const { c, scan } = cache();
    c.get(EVENTS);
    c.invalidate();
    c.get(EVENTS);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('a different event set (the snippet depends on it) scans again', () => {
    const { c, scan } = cache();
    c.get(EVENTS);
    c.get(EVENTS.slice(0, 2));
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
