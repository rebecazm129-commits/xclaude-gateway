// Unit tests for the xcg-cchook capturer (cchook.ts). Everything runs against
// an injected stdin (PassThrough) and a temp spool dir — never the real
// process stdin, never the real Application Support tree. The contract under
// test: always exit(0), never a byte to stdout/stderr, raw-bytes roundtrip.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach } from 'vitest';

import { runCchook, CCHOOK_MAX_BYTES, CCHOOK_STDIN_TIMEOUT_MS } from '../src/cchook.js';
import { cchookSpoolDir } from '../src/cchook-paths.js';

const ULID_JSON_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

// Synthetic stand-in with the shape of a real PostToolUse payload. The real
// spike v2.1.210 fixtures land in tests/fixtures/cchook/ (see TODO.md there);
// fixturePayloads() picks them up automatically once they exist.
const SYNTHETIC_POSTTOOLUSE = JSON.stringify({
  session_id: '4bb53a1a-6d24-4b05-8a17-000000000000',
  transcript_path: '/Users/u/.claude/projects/-p/4bb53a1a.jsonl',
  cwd: '/Users/u/p',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la', description: 'List files' },
  tool_response: { stdout: 'total 0\n', stderr: '', interrupted: false },
});

function fixturePayloads(): Array<{ name: string; bytes: Buffer }> {
  const dir = fileURLToPath(new URL('./fixtures/cchook/', import.meta.url));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, bytes: readFileSync(join(dir, f)) }));
}

const tmpDirs: string[] = [];
function tempSpoolDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'xcg-cchook-'));
  tmpDirs.push(base);
  // Deliberately a NOT-yet-existing subpath: proves the lazy mkdir.
  return join(base, 'claude-code', 'spool');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface RunResult {
  exits: number[];
  files: string[];
  spoolDir: string;
}

async function capture(
  payload: Buffer | string | null,
  opts: { spoolDir?: string; end?: boolean; maxBytes?: number; timeoutMs?: number; writeFileSync?: never } & {
    writeFileSyncImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<RunResult> {
  const spoolDir = opts.spoolDir ?? tempSpoolDir();
  const exits: number[] = [];
  const stdin = new PassThrough();
  const run = runCchook({
    stdin,
    spoolDir,
    exit: (code) => {
      exits.push(code);
    },
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.writeFileSyncImpl !== undefined
      ? { writeFileSync: opts.writeFileSyncImpl as never }
      : {}),
  });
  if (payload !== null) stdin.write(payload);
  if (opts.end !== false) stdin.end();
  await run;
  const files = existsSync(spoolDir) ? readdirSync(spoolDir) : [];
  return { exits, files, spoolDir };
}

describe('runCchook', () => {
  it('roundtrip: stdin bytes === spool file bytes (synthetic + real fixtures when present)', async () => {
    const payloads: Array<{ name: string; bytes: Buffer }> = [
      { name: 'synthetic-posttooluse', bytes: Buffer.from(SYNTHETIC_POSTTOOLUSE, 'utf8') },
      ...fixturePayloads(), // TODO(F1.1): 5 real spike v2.1.210 lines pending
    ];
    for (const { name, bytes } of payloads) {
      const { exits, files, spoolDir } = await capture(bytes);
      expect(exits, name).toEqual([0]);
      expect(files, name).toHaveLength(1);
      const written = readFileSync(join(spoolDir, files[0] as string));
      expect(written.equals(bytes), `${name}: bytes must roundtrip untouched`).toBe(true);
    }
  });

  it('creates the spool dir lazily, names the file with a valid ULID, mode 0o600', async () => {
    const spoolDir = tempSpoolDir();
    expect(existsSync(spoolDir)).toBe(false); // not there before first use
    const { exits, files } = await capture('{"hook_event_name":"Stop"}', { spoolDir });
    expect(exits).toEqual([0]);
    expect(existsSync(spoolDir)).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(ULID_JSON_RE);
    const mode = statSync(join(spoolDir, files[0] as string)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('empty stdin → exit 0 and NO file; whitespace-only → same', async () => {
    const empty = await capture(null);
    expect(empty.exits).toEqual([0]);
    expect(empty.files).toEqual([]);
    expect(existsSync(empty.spoolDir)).toBe(false); // not even the dir

    const blank = await capture('  \n\t \n');
    expect(blank.exits).toEqual([0]);
    expect(blank.files).toEqual([]);
  });

  it('fs failure → still exit 0, nothing thrown, not a byte to stdout/stderr', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write');
    const errSpy = vi.spyOn(process.stderr, 'write');
    const boom = vi.fn(() => {
      throw new Error('disk full');
    });
    const { exits, files } = await capture('{"hook_event_name":"Stop"}', {
      writeFileSyncImpl: boom,
    });
    expect(boom).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
    expect(files).toEqual([]);
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('payload over the cap → truncated to maxBytes, persisted, exit 0', async () => {
    // The 32 MiB product cap is pinned; the truncation logic is exercised with
    // a small injected cap to keep the test fast.
    expect(CCHOOK_MAX_BYTES).toBe(32 * 1024 * 1024);
    const cap = 64;
    const payload = Buffer.alloc(200, 0x61); // 'a' * 200
    const { exits, files, spoolDir } = await capture(payload, { maxBytes: cap });
    expect(exits).toEqual([0]);
    expect(files).toHaveLength(1);
    const written = readFileSync(join(spoolDir, files[0] as string));
    expect(written.length).toBe(cap);
    expect(written.equals(payload.subarray(0, cap))).toBe(true);
  });

  it("broken pipe: partial payload then 'error' → persists what was read, exit 0, silent", async () => {
    const outSpy = vi.spyOn(process.stdout, 'write');
    const errSpy = vi.spyOn(process.stderr, 'write');
    const spoolDir = tempSpoolDir();
    const exits: number[] = [];
    const stdin = new PassThrough();
    const run = runCchook({
      stdin,
      spoolDir,
      exit: (code) => {
        exits.push(code);
      },
    });
    const partial = '{"hook_event_name":"PostToolUse","tool_name":"Ba'; // writer died mid-payload
    stdin.write(partial);
    stdin.emit('error', new Error('EPIPE: broken pipe'));
    await run;
    expect(exits).toEqual([0]);
    const files = readdirSync(spoolDir);
    expect(files).toHaveLength(1);
    const written = readFileSync(join(spoolDir, files[0] as string));
    expect(written.toString('utf8')).toBe(partial);
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('hang guard: stdin never closes → persists what was read and exits 0', async () => {
    expect(CCHOOK_STDIN_TIMEOUT_MS).toBe(5_000);
    const partial = '{"hook_event_name":"PreToolUse"'; // writer stalled mid-payload
    const { exits, files, spoolDir } = await capture(partial, { end: false, timeoutMs: 40 });
    expect(exits).toEqual([0]);
    expect(files).toHaveLength(1);
    const written = readFileSync(join(spoolDir, files[0] as string));
    expect(written.toString('utf8')).toBe(partial);
  });
});

describe('cchookSpoolDir', () => {
  it('points inside baseDir/claude-code/spool', () => {
    expect(
      cchookSpoolDir().endsWith(join('xCLAUDE Gateway', 'claude-code', 'spool')),
    ).toBe(true);
  });
});
