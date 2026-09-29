// The spool cap (cchook-cap.ts): past too little free disk or too many files
// waiting, xcg-cchook writes nothing, counts the drop atomically, and still
// exits 0 with no output.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { runCchook } from '../src/cchook.js';
import {
  SPOOL_MAX_FILES,
  SPOOL_MIN_FREE_BYTES,
  recordSpoolDrop,
  spoolDroppedPath,
  spoolOverCap,
} from '../src/cchook-cap.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const PAYLOAD = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: {}, tool_response: {} });

const dirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), 'xcg-cap-'));
  dirs.push(d);
  return d;
}

async function hook(spoolDir: string, deps: Partial<Parameters<typeof runCchook>[0]> = {}) {
  const stdin = new PassThrough();
  const exits: number[] = [];
  const run = runCchook({ stdin, spoolDir, exit: (c) => void exits.push(c), auditKey: () => KEY, argv: [], ...deps });
  stdin.end(PAYLOAD);
  await run;
  return exits;
}

const counter = (spoolDir: string): number => {
  try {
    return statSync(spoolDroppedPath(spoolDir)).size;
  } catch {
    return 0;
  }
};
const spoolCount = (spoolDir: string): number => {
  try {
    return readdirSync(spoolDir).length;
  } catch {
    return 0;
  }
};

let out: MockInstance<typeof process.stdout.write>;
let err: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  out = vi.spyOn(process.stdout, 'write');
  err = vi.spyOn(process.stderr, 'write');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the thresholds', () => {
  it('the defaults: 2 GB free, 50,000 files', () => {
    expect(SPOOL_MIN_FREE_BYTES).toBe(2 * 1024 ** 3);
    expect(SPOOL_MAX_FILES).toBe(50_000);
  });

  it('low disk (simulated): nothing written, one drop counted, exit 0 without output', async () => {
    const spool = join(root(), 'claude-code', 'spool');
    const exits = await hook(spool, { spoolCap: { freeBytes: () => SPOOL_MIN_FREE_BYTES - 1 } });
    expect(exits).toEqual([0]);
    expect(spoolCount(spool)).toBe(0);
    expect(counter(spool)).toBe(1);
    expect(statSync(spoolDroppedPath(spool)).mode & 0o777).toBe(0o600);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('enough disk: the event is written as before', async () => {
    const spool = join(root(), 'claude-code', 'spool');
    await hook(spool, { spoolCap: { freeBytes: () => SPOOL_MIN_FREE_BYTES } });
    expect(spoolCount(spool)).toBe(1);
    expect(counter(spool)).toBe(0);
  });

  it('too many files (real readdir): past the limit nothing is written; at the limit it is', async () => {
    const spool = join(root(), 'claude-code', 'spool');
    mkdirSync(spool, { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(spool, `f${i}.json`), 'x');
    await hook(spool, { spoolLimits: { maxFiles: 3 } }); // 3 files, not > 3 → written
    expect(spoolCount(spool)).toBe(4);
    const exits = await hook(spool, { spoolLimits: { maxFiles: 3 } }); // 4 > 3 → dropped
    expect(exits).toEqual([0]);
    expect(spoolCount(spool)).toBe(4);
    expect(counter(spool)).toBe(1);
  });

  it('a spool dir that does not exist yet probes its parent for free space', () => {
    const spool = join(root(), 'claude-code', 'spool');
    const seen: string[] = [];
    const freeBytes = (p: string): number => {
      seen.push(p);
      if (p === spool) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return SPOOL_MIN_FREE_BYTES - 1;
    };
    expect(spoolOverCap(spool, {}, { freeBytes, countFiles: () => 0 })).toBe('disk');
    expect(seen).toEqual([spool, dirname(spool)]);
  });

  it('a check that fails never blocks a capture', () => {
    const boom = () => {
      throw new Error('unavailable');
    };
    expect(spoolOverCap('/nope/spool', {}, { freeBytes: boom, countFiles: boom })).toBeNull();
  });
});

describe('the drop counter', () => {
  it('two processes counting at once: every drop counted exactly once', async () => {
    const counterPath = join(root(), 'spool-dropped');
    const mod = fileURLToPath(new URL('../src/cchook-cap.ts', import.meta.url));
    const script = `import(${JSON.stringify(mod)}).then((m) => { for (let i = 0; i < 500; i++) m.recordSpoolDrop(${JSON.stringify(counterPath)}); });`;
    const run = promisify(execFile);
    await Promise.all([
      run(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script]),
      run(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script]),
    ]);
    expect(statSync(counterPath).size).toBe(1000);
    expect(statSync(counterPath).mode & 0o777).toBe(0o600);
  });

  it('in-process: one byte per drop', () => {
    const counterPath = join(root(), 'spool-dropped');
    for (let i = 0; i < 3; i++) recordSpoolDrop(counterPath);
    expect(statSync(counterPath).size).toBe(3);
  });
});
