// The "Not now" mark in the app's settings.json, and the ~ abbreviation of
// paths shown in the UI. Temp dirs only.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hookUpdateNotNow, readHookUpdatePrefs } from '../../src/main/hook-update-prefs.js';
import { readRetentionConfig, writeRetentionConfig } from '../../src/main/retention.js';
import { tildify } from '../../src/main/claude-settings-write.js';

const dirs: string[] = [];
function base(): string {
  const d = mkdtempSync(join(tmpdir(), 'xcg-hook-prefs-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the "Not now" mark', () => {
  it('stores the key of the set of changes; a later Not now replaces it', () => {
    const d = base();
    hookUpdateNotNow('Elicitation:missing', d);
    expect(readHookUpdatePrefs(d)).toEqual({ notNowKey: 'Elicitation:missing' });
    hookUpdateNotNow('SessionEnd:not_async', d);
    expect(readHookUpdatePrefs(d)).toEqual({ notNowKey: 'SessionEnd:not_async' });
  });

  it('the mark and retention share settings.json without erasing each other', async () => {
    const d = base();
    hookUpdateNotNow('k', d);
    expect(writeRetentionConfig({ purgeMode: '30d', sizeWarnBytes: 123 }, d).ok).toBe(true);
    expect(readHookUpdatePrefs(d)).toEqual({ notNowKey: 'k' });
    hookUpdateNotNow('k2', d);
    expect(await readRetentionConfig(d)).toEqual({ purgeMode: '30d', sizeWarnBytes: 123 });
    expect(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'))['v']).toBe(1);
  });

  it('absent settings → no mark', () => {
    expect(readHookUpdatePrefs(base())).toEqual({});
  });
});

describe('tildify', () => {
  it('abbreviates paths inside the home with ~, leaves others alone', () => {
    expect(tildify('/Users/u/Library/Application Support/xCLAUDE Gateway/backups/claude-settings', '/Users/u')).toBe(
      '~/Library/Application Support/xCLAUDE Gateway/backups/claude-settings',
    );
    expect(tildify('/Users/u', '/Users/u')).toBe('~');
    expect(tildify('/Users/uu/x', '/Users/u')).toBe('/Users/uu/x');
    expect(tildify('/opt/dotfiles/settings.json', '/Users/u')).toBe('/opt/dotfiles/settings.json');
  });
});
