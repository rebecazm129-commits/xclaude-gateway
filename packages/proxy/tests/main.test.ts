// Tests for the xcg-proxy subcommand dispatcher (Hito 6 sub-step 2.b).
// Only covers paths where main(argv) returns a code without invoking
// runStdio: the happy 'stdio' path spawns a child and is covered by the
// runtime smoke (cannot be unit-tested without mocking runStdio).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../src/main.js';

describe('xcg-proxy main(argv) dispatcher (Hito 6 sub-step 2.b)', () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns EXIT_USAGE_OR_CORRUPT when subcommand is missing', () => {
    expect(main([])).toBe(2);
    expect(stderrChunks.join('')).toContain('unknown subcommand: (none)');
  });

  it('returns EXIT_USAGE_OR_CORRUPT for an unknown subcommand', () => {
    expect(main(['bogus'])).toBe(2);
    expect(stderrChunks.join('')).toContain('unknown subcommand: bogus');
  });

  it('http without --url: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['http'])).toBe(2);
    expect(stderrChunks.join('')).toContain('--url is required');
  });

  it('http with --url but without --name: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['http', '--url', 'http://example.com'])).toBe(2);
    expect(stderrChunks.join('')).toContain('--name is required');
  });

  it('http with an unknown flag: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['http', '--unknown'])).toBe(2);
  });

  it('stdio without --wrap: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['stdio'])).toBe(2);
    expect(stderrChunks.join('')).toContain('--wrap is required');
  });

  it('stdio with --wrap but without --name: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['stdio', '--wrap', '/bin/echo'])).toBe(2);
    expect(stderrChunks.join('')).toContain('--name is required');
  });

  it('stdio with an unknown flag: EXIT_USAGE_OR_CORRUPT', () => {
    expect(main(['stdio', '--unknown'])).toBe(2);
  });

  it('legacy --wrap form dispatches to stdio (back-compat)', () => {
    expect(main(['--wrap', '/bin/echo'])).toBe(2);
    expect(stderrChunks.join('')).toContain('--name is required');
  });

  // Happy path (`stdio --wrap X --name Y -- args`) is NOT unit-tested: it
  // would invoke runStdio which spawns a child process and attaches event
  // listeners. The smoke (npm) covers it: see sub-step 2.a verification.
});
