// xcg-cchook — pure capturer for Claude Code hook payloads (F1.1).
//
// INVIOLABLE CONTRACT: this process ALWAYS exits 0, NEVER writes to stdout or
// stderr, and no error may escape (catch-all). A hook that fails or blocks
// would degrade Claude Code itself; losing one capture is always preferable.
//
// It does exactly one thing: read stdin (the hook's JSON payload) and persist
// the raw bytes as ONE spool file per invocation — ${ulid()}.json under
// cchookSpoolDir(). No parsing, no validation of the payload's shape: parsing
// is F1.2's job, downstream, off the hook's critical path.
//
// Allowed dependencies: node:fs, node:path, node:os, ulid. Nothing else.

import { mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { cchookSpoolDir } from './cchook-paths.js';

/** Hard cap on captured bytes. Past it, input is truncated but stdin keeps
 *  being drained (capture-all: the writer must never block on us). */
export const CCHOOK_MAX_BYTES = 32 * 1024 * 1024;

/** Hang guard: if stdin hasn't closed by then, persist what was read, exit 0. */
export const CCHOOK_STDIN_TIMEOUT_MS = 5_000;

// Every collaborator is injectable so tests can drive the capturer without a
// real process (same seam style as AsyncDetectorNer's forkImpl). Defaults are
// the real thing.
export interface CchookDeps {
  stdin?: NodeJS.ReadableStream;
  spoolDir?: string;
  mkdirSync?: typeof fsMkdirSync;
  writeFileSync?: typeof fsWriteFileSync;
  exit?: (code: 0) => void;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function runCchook(deps: CchookDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: 0): void => process.exit(code));
  try {
    const stdin = deps.stdin ?? process.stdin;
    const maxBytes = deps.maxBytes ?? CCHOOK_MAX_BYTES;
    const timeoutMs = deps.timeoutMs ?? CCHOOK_STDIN_TIMEOUT_MS;
    const mkdirSync = deps.mkdirSync ?? fsMkdirSync;
    const writeFileSync = deps.writeFileSync ?? fsWriteFileSync;

    const chunks: Buffer[] = [];
    let total = 0;

    await new Promise<void>((resolve) => {
      // Hang guard: a hook whose stdin never closes must not leave a zombie
      // capturer behind. On fire we fall through to persist-what-we-have.
      const timer = setTimeout(resolve, timeoutMs);
      stdin.on('data', (chunk: Buffer | string) => {
        if (total >= maxBytes) return; // past the cap: keep draining, discard
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const room = maxBytes - total;
        if (buf.length > room) {
          chunks.push(buf.subarray(0, room));
          total = maxBytes;
        } else {
          chunks.push(buf);
          total += buf.length;
        }
      });
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      stdin.on('end', done);
      stdin.on('error', done); // a broken pipe is still a capture attempt
    });

    const payload = Buffer.concat(chunks);
    // Empty or whitespace-only payload: nothing to spool, no file created.
    if (payload.length === 0 || payload.toString('utf8').trim().length === 0) {
      exit(0);
      return;
    }

    const dir = deps.spoolDir ?? cchookSpoolDir();
    // Lazy, first-use creation — same pattern as the refresh lock dir.
    mkdirSync(dir, { recursive: true });
    // One file per invocation, raw bytes as received. 'wx' so a (negligible)
    // ULID collision can never clobber an existing capture; 0o600 like every
    // credential-adjacent file we write.
    writeFileSync(join(dir, `${ulid()}.json`), payload, { flag: 'wx', mode: 0o600 });
  } catch {
    // Catch-all: a lost capture is acceptable; a failing hook is not.
  }
  exit(0);
}
