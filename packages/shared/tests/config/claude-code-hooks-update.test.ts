// Capability check and update of an EXISTING Claude Code hook install
// (checkCchookHooks / updateCchookHooks): an install from before a hook event
// existed is outdated, not "registered"; the update adds what is missing and
// fixes only our own commands, never anything else.

import { describe, expect, it } from 'vitest';

import {
  CCHOOK_EVENTS,
  buildCchookHookEntry,
  cchookEventsFor,
  cchookInstallSnippet,
  cchookUpdateSnippet,
  checkCchookHooks,
  compareVersions,
  fixableCchookIssues,
  mergeCchookHooks,
  updateCchookHooks,
} from '../../src/config/claude-code-hooks.js';

const LAUNCHER = 'exec "$HOME/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"';
const OLD_EVENTS = ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd'] as const;

// What an install made before elicitation wrote: the four original events,
// each with the argument-less entry.
const oldInstall = (): Record<string, unknown> => ({
  model: 'claude-fable-5',
  hooks: Object.fromEntries(OLD_EVENTS.map((e) => [e, [buildCchookHookEntry()]])),
});

const FOREIGN_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash', args: ['-c', 'echo user-hook'] }] };
const FOREIGN_ITEM = { type: 'command', command: '/usr/local/bin/audit-me', async: false };

const hooksOf = (settings: Record<string, unknown>) => settings['hooks'] as Record<string, Record<string, unknown>[]>;

describe('checkCchookHooks', () => {
  it('no hook of ours → not_installed (empty, foreign only, non-object)', () => {
    expect(checkCchookHooks({})).toEqual({ state: 'not_installed' });
    expect(checkCchookHooks({ hooks: { PostToolUse: [FOREIGN_ENTRY] } })).toEqual({ state: 'not_installed' });
    for (const bad of [null, 'x', 42, []]) expect(checkCchookHooks(bad)).toEqual({ state: 'not_installed' });
  });

  it('a fresh install of this build → up_to_date', () => {
    expect(checkCchookHooks(mergeCchookHooks({}).settings)).toEqual({ state: 'up_to_date' });
  });

  it('an install from before elicitation → outdated, missing the two new events', () => {
    expect(checkCchookHooks(oldInstall())).toEqual({
      state: 'outdated',
      issues: [
        { event: 'Elicitation', problem: 'missing' },
        { event: 'ElicitationResult', problem: 'missing' },
      ],
    });
  });

  it('our entry without async: true → not_async', () => {
    const settings = mergeCchookHooks({}).settings;
    const entry = hooksOf(settings)['SessionEnd']![0]!;
    (entry['hooks'] as Record<string, unknown>[])[0]!['async'] = false;
    expect(checkCchookHooks(settings)).toEqual({ state: 'outdated', issues: [{ event: 'SessionEnd', problem: 'not_async' }] });
  });

  it('ElicitationResult without --event (or with the wrong one) → missing_event_arg', () => {
    for (const script of [LAUNCHER, `${LAUNCHER} --event Elicitation`]) {
      const settings = mergeCchookHooks({}).settings;
      hooksOf(settings)['ElicitationResult'] = [
        { matcher: '*', hooks: [{ type: 'command', command: 'bash', args: ['-c', script], async: true }] },
      ];
      expect(checkCchookHooks(settings)).toEqual({
        state: 'outdated',
        issues: [{ event: 'ElicitationResult', problem: 'missing_event_arg' }],
      });
    }
  });

  it('--event on an event that must not carry it → unexpected_event_arg', () => {
    const settings = mergeCchookHooks({}).settings;
    hooksOf(settings)['PostToolUse'] = [buildCchookHookEntry('ElicitationResult') as unknown as Record<string, unknown>];
    expect(checkCchookHooks(settings)).toEqual({
      state: 'outdated',
      issues: [{ event: 'PostToolUse', problem: 'unexpected_event_arg' }],
    });
  });

  it('foreign hooks next to ours do not change the verdict', () => {
    const settings = mergeCchookHooks({ hooks: { PostToolUse: [FOREIGN_ENTRY], Stop: [FOREIGN_ENTRY] } }).settings;
    expect(checkCchookHooks(settings)).toEqual({ state: 'up_to_date' });
  });
});

describe('updateCchookHooks', () => {
  it('an old install becomes up_to_date: the new events added, the rest untouched', () => {
    const before = oldInstall();
    const { settings, changed } = updateCchookHooks(before);
    expect(changed).toBe(true);
    expect(checkCchookHooks(settings)).toEqual({ state: 'up_to_date' });
    expect(settings['model']).toBe('claude-fable-5');
    for (const e of OLD_EVENTS) expect(hooksOf(settings)[e]).toEqual([buildCchookHookEntry()]);
    expect(hooksOf(settings)['ElicitationResult']).toEqual([buildCchookHookEntry('ElicitationResult')]);
    // The input is not mutated.
    expect(Object.keys(hooksOf(before))).toEqual([...OLD_EVENTS]);
  });

  it('fixes our own commands (async, --event) and nothing else', () => {
    const settings = mergeCchookHooks({}).settings;
    const hooks = hooksOf(settings);
    hooks['SessionEnd'] = [
      FOREIGN_ENTRY,
      { matcher: '*', hooks: [FOREIGN_ITEM, { type: 'command', command: 'bash', args: ['-c', LAUNCHER] }] },
    ];
    hooks['ElicitationResult'] = [{ matcher: '*', hooks: [{ type: 'command', command: 'bash', args: ['-c', LAUNCHER], async: true }] }];
    hooks['Stop'] = [FOREIGN_ENTRY];

    const { settings: out, changed } = updateCchookHooks(settings);
    expect(changed).toBe(true);
    expect(checkCchookHooks(out)).toEqual({ state: 'up_to_date' });
    const outHooks = hooksOf(out);
    // Foreign entry and the foreign command inside our entry: byte for byte.
    expect(outHooks['SessionEnd']![0]).toEqual(FOREIGN_ENTRY);
    expect((outHooks['SessionEnd']![1]!['hooks'] as unknown[])[0]).toEqual(FOREIGN_ITEM);
    expect((outHooks['SessionEnd']![1]!['hooks'] as unknown[])[1]).toEqual(buildCchookHookEntry().hooks[0]);
    expect(outHooks['ElicitationResult']).toEqual([buildCchookHookEntry('ElicitationResult')]);
    expect(outHooks['Stop']).toEqual([FOREIGN_ENTRY]);
  });

  it('idempotent: a second update changes nothing', () => {
    const once = updateCchookHooks(oldInstall()).settings;
    const twice = updateCchookHooks(once);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toEqual(once);
  });

  it('an up-to-date install is left as it is', () => {
    const fresh = mergeCchookHooks({ hooks: { Stop: [FOREIGN_ENTRY] } }).settings;
    const { settings, changed } = updateCchookHooks(fresh);
    expect(changed).toBe(false);
    expect(settings).toEqual(fresh);
  });

  it('every CCHOOK_EVENTS event ends with exactly one entry of ours', () => {
    const { settings } = updateCchookHooks(oldInstall());
    for (const e of CCHOOK_EVENTS) expect(hooksOf(settings)[e]).toHaveLength(1);
  });
});

describe('custom hook path', () => {
  const custom = { type: 'command', command: '/usr/local/bin/xcg-cchook' };

  it('ours (marker) but not the standard launcher → custom_path, not fixable', () => {
    const settings = mergeCchookHooks({}).settings;
    hooksOf(settings)['SessionStart'] = [{ matcher: '*', hooks: [custom] }];
    const check = checkCchookHooks(settings);
    expect(check).toEqual({ state: 'outdated', issues: [{ event: 'SessionStart', problem: 'custom_path' }] });
    expect(fixableCchookIssues(check)).toEqual([]);
  });

  it('the update never replaces it — not even to add async or --event — but adds missing events', () => {
    const settings = { hooks: { SessionStart: [{ matcher: '*', hooks: [custom] }], Elicitation: [{ matcher: '*', hooks: [custom] }] } };
    const { settings: out } = updateCchookHooks(settings);
    expect(hooksOf(out)['SessionStart']).toEqual([{ matcher: '*', hooks: [custom] }]);
    expect(hooksOf(out)['Elicitation']).toEqual([{ matcher: '*', hooks: [custom] }]);
    expect(hooksOf(out)['PostToolUse']).toEqual([buildCchookHookEntry()]);
    expect(fixableCchookIssues(checkCchookHooks(out))).toEqual([]);
  });

  it('a hand-written entry of ours without a hooks array is custom too, and left alone', () => {
    const handWritten = { matcher: '*', command: 'xcg-cchook' };
    const settings = mergeCchookHooks({}).settings;
    hooksOf(settings)['SessionEnd'] = [handWritten];
    expect(checkCchookHooks(settings)).toEqual({ state: 'outdated', issues: [{ event: 'SessionEnd', problem: 'custom_path' }] });
    expect(hooksOf(updateCchookHooks(settings).settings)['SessionEnd']).toEqual([handWritten]);
  });
});

describe('Claude Code version gating (elicitation since 2.1.76)', () => {
  const WITHOUT = CCHOOK_EVENTS.filter((e) => e !== 'Elicitation' && e !== 'ElicitationResult');

  it('compareVersions is numeric, not lexical', () => {
    expect(compareVersions('2.1.76', '2.1.76')).toBe(0);
    expect(compareVersions('2.1.100', '2.1.76')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.76')).toBeLessThan(0);
    expect(compareVersions('3.0.0', '2.9.999')).toBeGreaterThan(0);
  });

  it('older or unknown → every event but the two elicitation ones; 2.1.76 and later → all', () => {
    expect(cchookEventsFor(null)).toEqual(WITHOUT);
    expect(cchookEventsFor('2.1.75')).toEqual(WITHOUT);
    expect(cchookEventsFor('2.0.99')).toEqual(WITHOUT);
    expect(cchookEventsFor('2.1.76')).toEqual(CCHOOK_EVENTS);
    expect(cchookEventsFor('2.1.283')).toEqual(CCHOOK_EVENTS);
  });

  it('install and update with the older set do not add Elicitation / ElicitationResult', () => {
    const events = cchookEventsFor('2.1.50');
    const installed = hooksOf(mergeCchookHooks({}, { events }).settings);
    expect(installed['Elicitation']).toBeUndefined();
    expect(installed['ElicitationResult']).toBeUndefined();
    const updated = hooksOf(updateCchookHooks(oldInstall(), { events }).settings);
    expect(updated['Elicitation']).toBeUndefined();
    expect(updated['ElicitationResult']).toBeUndefined();
  });

  it('with the older set an old install is up to date (nothing to offer)', () => {
    expect(checkCchookHooks(oldInstall(), { events: cchookEventsFor(null) })).toEqual({ state: 'up_to_date' });
  });
});

describe('hook configuration snippet (settings managed externally)', () => {
  it('install: one entry of ours per supported event — nothing else', () => {
    expect(cchookInstallSnippet(CCHOOK_EVENTS)).toEqual({
      hooks: Object.fromEntries(CCHOOK_EVENTS.map((e) => [e, [buildCchookHookEntry(e)]])),
    });
  });

  it('install: filtered by the detected Claude Code version', () => {
    const older = cchookInstallSnippet(cchookEventsFor('2.1.50'));
    expect(Object.keys(older.hooks)).toEqual(['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd']);
    expect(Object.keys(cchookInstallSnippet(cchookEventsFor('2.1.76')).hooks)).toEqual([...CCHOOK_EVENTS]);
  });

  it('update: only what is missing or outdated; never foreign hooks, other settings or custom paths', () => {
    const settings = oldInstall();
    hooksOf(settings)['Stop'] = [FOREIGN_ENTRY];
    hooksOf(settings)['SessionEnd'] = [
      { matcher: '*', hooks: [{ type: 'command', command: 'bash', args: ['-c', LAUNCHER] }] }, // not async
    ];
    hooksOf(settings)['SessionStart'] = [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/xcg-cchook' }] }];
    const snippet = cchookUpdateSnippet(settings, CCHOOK_EVENTS);
    expect(snippet).toEqual({
      hooks: {
        SessionEnd: [buildCchookHookEntry('SessionEnd')],
        Elicitation: [buildCchookHookEntry('Elicitation')],
        ElicitationResult: [buildCchookHookEntry('ElicitationResult')],
      },
    });
    const text = JSON.stringify(snippet);
    expect(text).not.toContain('echo user-hook');
    expect(text).not.toContain('claude-fable-5');
    expect(Object.keys(snippet)).toEqual(['hooks']);
  });

  it('update with an older Claude Code: the elicitation entries are not offered', () => {
    expect(cchookUpdateSnippet(oldInstall(), cchookEventsFor(null))).toEqual({ hooks: {} });
  });
});
