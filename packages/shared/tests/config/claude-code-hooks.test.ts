// Unit tests for the pure Claude Code hooks merge/remove (claude-code-hooks.ts):
// idempotent merge that adopts manual registrations, surgical removal that
// never touches foreign entries, and the merge→remove roundtrip.

import { describe, expect, it } from 'vitest';

import {
  CCHOOK_EVENTS,
  CCHOOK_MARKER,
  buildCchookHookEntry,
  mergeCchookHooks,
  removeCchookHooks,
} from '../../src/config/claude-code-hooks.js';

const FOREIGN_HOOK = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'bash', args: ['-c', 'echo user-hook'] }],
};

describe('buildCchookHookEntry', () => {
  it('is the dogfood-validated shape: bash -c with the quoted launcher path, async', () => {
    const entry = buildCchookHookEntry();
    expect(entry.matcher).toBe('*');
    expect(entry.hooks).toHaveLength(1);
    const cmd = entry.hooks[0]!;
    expect(cmd.type).toBe('command');
    expect(cmd.command).toBe('bash');
    expect(cmd.args[0]).toBe('-c');
    // Quoted path (space in 'Application Support') and exec, per the F1.4 lesson.
    expect(cmd.args[1]).toBe('exec "$HOME/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"');
    expect(cmd.async).toBe(true);
    expect(JSON.stringify(entry)).toContain(CCHOOK_MARKER);
  });
});

describe('mergeCchookHooks', () => {
  it('empty settings → registers all four events, changed', () => {
    const { settings, changed } = mergeCchookHooks({});
    expect(changed).toBe(true);
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    for (const event of CCHOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      expect(JSON.stringify(hooks[event])).toContain(CCHOOK_MARKER);
    }
  });

  it('preserves foreign hooks and foreign settings fields', () => {
    const original = {
      model: 'claude-fable-5',
      hooks: { PostToolUse: [FOREIGN_HOOK], Stop: [FOREIGN_HOOK] },
    };
    const { settings, changed } = mergeCchookHooks(original);
    expect(changed).toBe(true);
    expect(settings['model']).toBe('claude-fable-5');
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks['PostToolUse']).toHaveLength(2); // foreign kept + ours appended
    expect(hooks['PostToolUse']![0]).toEqual(FOREIGN_HOOK);
    expect(hooks['Stop']).toEqual([FOREIGN_HOOK]); // untouched foreign event
    // The input object itself was not mutated.
    expect(original.hooks.PostToolUse).toHaveLength(1);
  });

  it('idempotent: an existing manual registration is adopted, changed:false', () => {
    const first = mergeCchookHooks({}).settings;
    const again = mergeCchookHooks(first);
    expect(again.changed).toBe(false);

    // Manual variant (different args shape) still counts via the marker.
    const manual = {
      hooks: Object.fromEntries(
        CCHOOK_EVENTS.map((e) => [
          e,
          [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/xcg-cchook' }] }],
        ]),
      ),
    };
    expect(mergeCchookHooks(manual).changed).toBe(false);
  });

  it('partial manual registration → only the missing events are added', () => {
    const partial = { hooks: { PostToolUse: [buildCchookHookEntry()] } };
    const { settings, changed } = mergeCchookHooks(partial);
    expect(changed).toBe(true);
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks['PostToolUse']).toHaveLength(1); // not duplicated
    expect(hooks['SessionStart']).toHaveLength(1);
  });

  it('non-object settings → treated as {}', () => {
    for (const bad of [null, 'text', 42, ['array']]) {
      const { settings, changed } = mergeCchookHooks(bad);
      expect(changed).toBe(true);
      expect((settings['hooks'] as Record<string, unknown[]>)['PostToolUse']).toHaveLength(1);
    }
  });
});

describe('removeCchookHooks', () => {
  it('surgical: removes only marker entries, preserves foreign, prunes empties', () => {
    const merged = mergeCchookHooks({
      theme: 'dark',
      hooks: { PostToolUse: [FOREIGN_HOOK] },
    }).settings;

    const { settings, changed } = removeCchookHooks(merged);
    expect(changed).toBe(true);
    expect(settings['theme']).toBe('dark');
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks['PostToolUse']).toEqual([FOREIGN_HOOK]); // foreign survives
    // Our-only events were pruned entirely (empty arrays removed).
    expect('SessionStart' in hooks).toBe(false);
    expect('SessionEnd' in hooks).toBe(false);
  });

  it('a marker entry under a NON-cchook event is removed too', () => {
    const input = {
      hooks: {
        Stop: [FOREIGN_HOOK, buildCchookHookEntry()],
      },
    };
    const { settings, changed } = removeCchookHooks(input);
    expect(changed).toBe(true);
    expect((settings['hooks'] as Record<string, unknown[]>)['Stop']).toEqual([FOREIGN_HOOK]);
  });

  it('prunes the hooks object itself when nothing remains; never touches unmarked', () => {
    const onlyOurs = mergeCchookHooks({}).settings;
    const removed = removeCchookHooks(onlyOurs);
    expect(removed.changed).toBe(true);
    expect('hooks' in removed.settings).toBe(false);

    const untouched = { hooks: { PostToolUse: [FOREIGN_HOOK] } };
    const noop = removeCchookHooks(untouched);
    expect(noop.changed).toBe(false);
    expect(noop.settings['hooks']).toEqual(untouched.hooks);
  });

  it('roundtrip: merge → remove ≈ original', () => {
    const original = {
      model: 'claude-fable-5',
      hooks: { PostToolUse: [FOREIGN_HOOK] },
      permissions: { allow: ['Bash(ls:*)'] },
    };
    const merged = mergeCchookHooks(original).settings;
    const back = removeCchookHooks(merged).settings;
    expect(back).toEqual(original);
  });
});
