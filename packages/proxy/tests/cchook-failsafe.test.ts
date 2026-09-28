// The hook's process-level failsafe: what runCchook's own try/catch cannot
// reach — an exception thrown from a stream callback, a stray rejection —
// must still end in exit 0 with nothing on stdout or stderr.

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFailsafe } from '../src/cchook.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installFailsafe', () => {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    it(`${event} → exit 0, not a byte to stdout or stderr`, () => {
      const proc = new EventEmitter();
      const exit = vi.fn();
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      installFailsafe(proc as unknown as Pick<NodeJS.Process, 'on'>, exit);
      proc.emit(event, new Error('boom inside a stream callback'));
      expect(exit).toHaveBeenCalledWith(0);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    });
  }
});
