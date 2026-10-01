// Dismiss on a ~/.claude-* profile notice: persisted by path in the app's
// settings.json, for good, without touching the other keys.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  dismissProfile,
  isProfilePath,
  readDismissedProfiles,
  visibleProfiles,
} from '../../src/main/profile-notice-prefs.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'xcg-profile-prefs-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const P = (path: string) => ({ path, snippet: '{}' });

describe('profile notice Dismiss', () => {
  it('a dismissed path is persisted and read back (also by a fresh process)', () => {
    expect(readDismissedProfiles(base)).toEqual([]);
    dismissProfile('~/.claude-work', base);
    expect(readDismissedProfiles(base)).toEqual(['~/.claude-work']);
  });

  it('per path: hiding one folder keeps the others visible', () => {
    dismissProfile('~/.claude-work', base);
    const shown = visibleProfiles([P('~/.claude-work'), P('~/.claude-personal')], readDismissedProfiles(base));
    expect(shown.map((p) => p.path)).toEqual(['~/.claude-personal']);
  });

  it('idempotent and sorted; other settings keys are kept', () => {
    writeFileSync(join(base, 'settings.json'), JSON.stringify({ v: 1, retention: { mode: 'never' } }));
    dismissProfile('~/.claude-zeta', base);
    dismissProfile('~/.claude-alpha', base);
    dismissProfile('~/.claude-zeta', base);
    expect(readDismissedProfiles(base)).toEqual(['~/.claude-alpha', '~/.claude-zeta']);
    const raw = JSON.parse(readFileSync(join(base, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['retention']).toEqual({ mode: 'never' });
  });

  it('only a path the scan could produce is accepted', () => {
    for (const bad of ['~/.claude', '~/.claude.json', '/etc/passwd', '~/.claude-a/b', '../x', 42, null]) {
      expect(isProfilePath(bad)).toBe(false);
    }
    dismissProfile('/etc/passwd', base);
    expect(readDismissedProfiles(base)).toEqual([]);
  });

  it('garbage in the stored list is ignored', () => {
    writeFileSync(join(base, 'settings.json'), JSON.stringify({ claudeCodeProfilesDismissed: ['~/.claude-ok', '/nope', 7] }));
    expect(readDismissedProfiles(base)).toEqual(['~/.claude-ok']);
  });
});
