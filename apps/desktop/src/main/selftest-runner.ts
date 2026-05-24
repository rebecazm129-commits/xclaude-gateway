// Self-test IO layer (C2.B.1.a) — the side-effecting half of the Verify
// Detection feature. Spawns the real xcg-proxy wrapper around
// @modelcontextprotocol/server-everything, drives a minimal MCP client over
// stdio, and reads detections back from the per-session audit JSONL.
//
// This module is deliberately NOT a pure handler: it spawns processes and
// touches the filesystem. The pure orchestrator (C2.B.1.b, selftest-handler.ts)
// injects these functions as seams and is unit-tested with mocks. This layer is
// validated by smoke (see /tmp/xcg-smoke.mjs reference run).
//
// Detection fires on the OUTBOUND request frame as it passes through the
// wrapper's stdin observer, independent of whether server-everything is ready
// or even alive — so the readback does not wait on the npx fetch / MCP server.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import { toEchoToolCallParams, type SelfTestExample } from '@xcg/shared';
import { parseConfig } from '@xcg/shared/config';

/**
 * Reserved wrapper --name for self-test runs. Single source of truth: the
 * runner spawns with this name, and detection-reader.ts excludes events whose
 * `mcp` field equals it from the audit dashboard (C2.B.1.a, decision A).
 */
export const SELFTEST_WRAPPER_NAME = 'xcg-selftest';

export interface WrapperHandle {
  readonly session: string;
  readonly auditFile: string;
  /** Write a JSON-RPC frame to the wrapper's stdin (newline-delimited). */
  send(jsonRpcFrame: object): void;
  /** SIGTERM, wait up to 3s for exit, escalate to SIGKILL. Idempotent. */
  kill(): Promise<void>;
}

export interface SpawnWrapperOptions {
  /** Real proxy binary path (from resolveXcgTargetPathFromMain()). */
  readonly proxyBinPath: string;
  /** Absolute npx path (from resolveNpxPath()). */
  readonly npxPath: string;
  /** MCP server package to wrap, e.g. '@modelcontextprotocol/server-everything'. */
  readonly serverPackage: string;
  /** Wrapper --name; RESERVED value 'xcg-selftest' is excluded from the dashboard. */
  readonly wrapperName: string;
  /** Timeout for discovering the session from the wrapper's stderr bootstrap line. */
  readonly discoveryTimeoutMs: number;
}

export interface DetectionResult {
  readonly category: string;
  readonly severity: string;
}

/**
 * Spawn the wrapper and resolve once it announces its session + audit file on
 * stderr. Rejects on timeout, spawn error, or premature exit (with the full
 * captured stderr to aid diagnosis).
 */
export async function spawnWrapper(opts: SpawnWrapperOptions): Promise<WrapperHandle> {
  const child = spawn(
    opts.proxyBinPath,
    ['--wrap', opts.npxPath, '--name', opts.wrapperName, '--', '-y', opts.serverPackage],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return await new Promise<WrapperHandle>((resolve, reject) => {
    let settled = false;
    let stderrBuf = '';
    const stderrAll: string[] = [];
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onStderr = (chunk: Buffer): void => {
      const text = chunk.toString();
      stderrAll.push(text);
      stderrBuf += text;
      // Match only complete lines (terminated by \n): a chunk boundary can split
      // the audit path, and a premature match would truncate it.
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const m = line.match(/^xcg-proxy: session ([0-9A-Z]+) auditing to (.+)$/);
        if (m && !settled) {
          settled = true;
          cleanup();
          resolve(makeHandle(child, m[1]!, m[2]!));
          return;
        }
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `wrapper exited (code=${code}, signal=${signal}) before announcing session; stderr:\n${stderrAll.join('')}`,
        ),
      );
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`failed to spawn wrapper: ${err.message}`));
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      reject(
        new Error(
          `session discovery timed out after ${opts.discoveryTimeoutMs}ms; stderr:\n${stderrAll.join('')}`,
        ),
      );
    }, opts.discoveryTimeoutMs);

    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

function makeHandle(
  child: ChildProcessWithoutNullStreams,
  session: string,
  auditFile: string,
): WrapperHandle {
  return {
    session,
    auditFile,
    send(frame: object): void {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    async kill(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        let killTimer: NodeJS.Timeout | undefined;
        child.once('exit', () => {
          if (killTimer !== undefined) clearTimeout(killTimer);
          resolve();
        });
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      });
    },
  };
}

/**
 * Resolve an absolute npx path by layers:
 *   1. An absolute npx already used by a wrap in the user's config (proven to
 *      work with Claude Desktop). Position-independent: scans command + all
 *      args of every mcpServers entry for the first absolute path named 'npx'.
 *   2. process.env.PATH (may be sparse in a packaged Electron app).
 *   3. Known macOS locations.
 * Returns null if none resolve (the caller maps this to spawn_failed).
 */
export function resolveNpxPath(configPath: string): string | null {
  const fromConfig = npxFromConfig(configPath);
  if (fromConfig !== null) return fromConfig;

  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'npx');
    if (existsSync(candidate)) return candidate;
  }

  for (const candidate of ['/usr/local/bin/npx', '/opt/homebrew/bin/npx']) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function npxFromConfig(configPath: string): string | null {
  const parsed = parseConfig(configPath);
  if (!parsed.ok) return null;
  const raw = parsed.raw;
  if (typeof raw !== 'object' || raw === null) return null;
  const mcpServers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null) return null;

  for (const entry of Object.values(mcpServers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { command?: unknown; args?: unknown };
    const tokens: string[] = [];
    if (typeof e.command === 'string') tokens.push(e.command);
    if (Array.isArray(e.args)) {
      for (const a of e.args) if (typeof a === 'string') tokens.push(a);
    }
    for (const tok of tokens) {
      if (isAbsolute(tok) && basename(tok) === 'npx' && existsSync(tok)) {
        return tok;
      }
    }
  }
  return null;
}

/**
 * Poll the audit JSONL, collecting the detection block for each expected rpcId
 * observed in our session. Returns when every expected rpcId is seen or the
 * timeout elapses (a partial map is returned on timeout; the orchestrator maps
 * missing ids to its failure modes).
 *
 * Note (E): a single request can in principle emit multiple mcp.request events
 * (one per detection). Our payloads are isolated (length===1), so this collapses
 * to one; first-seen wins.
 */
export async function readDetectionsFromAudit(
  auditFile: string,
  session: string,
  expectedRpcIds: readonly number[],
  timeoutMs: number,
): Promise<Map<number, DetectionResult>> {
  const expected = new Set<number>(expectedRpcIds);
  const found = new Map<number, DetectionResult>();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    scanInto(auditFile, session, expected, found);
    if (found.size === expected.size) return found;
    if (Date.now() >= deadline) {
      scanInto(auditFile, session, expected, found);
      return found;
    }
    await delay(100);
  }
}

function scanInto(
  auditFile: string,
  session: string,
  expected: ReadonlySet<number>,
  found: Map<number, DetectionResult>,
): void {
  let content: string;
  try {
    content = readFileSync(auditFile, 'utf8');
  } catch {
    return; // file may not exist yet; retry next tick
  }
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // half-written final line; picked up next scan
    }
    if (typeof ev !== 'object' || ev === null) continue;
    const o = ev as Record<string, unknown>;
    if (o['type'] !== 'mcp.request') continue;
    if (o['session'] !== session) continue;
    const rpcId = o['rpcId'];
    if (typeof rpcId !== 'number' || !expected.has(rpcId) || found.has(rpcId)) continue;
    const det = o['detection'];
    if (typeof det !== 'object' || det === null) continue;
    const block = det as Record<string, unknown>;
    const category = block['category'];
    const severity = block['severity'];
    if (typeof category !== 'string' || typeof severity !== 'string') continue;
    found.set(rpcId, { category, severity });
  }
}

/**
 * Build the JSON-RPC initialize frame for the MCP handshake. The wrapper is a
 * transparent pipe, so this is consumed by the wrapped server; detection does
 * not depend on it, but a clean handshake keeps the server happy.
 */
export function buildInitializeFrame(rpcId: number): object {
  return {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: SELFTEST_WRAPPER_NAME, version: '0.0.0' },
    },
  };
}

/** Build the JSON-RPC notifications/initialized frame (a notification, no id). */
export function buildInitializedNotification(): object {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
}

/**
 * Build the JSON-RPC tools/call frame for an example, embedding the textual
 * trigger as the echo tool's `message` argument via the shared helper.
 */
export function buildToolCallFrame(rpcId: number, example: SelfTestExample): object {
  return {
    jsonrpc: '2.0',
    id: rpcId,
    method: example.method,
    params: toEchoToolCallParams(example),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
