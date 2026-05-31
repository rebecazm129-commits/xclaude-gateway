// Connect orchestrator (Hito 6 Fase 5, Pieza A) — the pure half of the atomic
// connect operation. Composes login + add-remote in one op: a name-exists
// pre-check (so we never open a browser for a name that is already taken),
// then the interactive login, then writing the bridge entry.
//
// login is the only injectable seam (it spawns a process); parseConfig and
// runConfigAddRemote are imported directly (deterministic / already tested).
// Order is login-first, NO rollback: the entry is written only after a
// successful login, so the config never holds a remote entry without a token.
// Unit-tested with a mocked login (tests/main/connect-handler.test.ts).

import { parseConfig } from '@xcg/shared/config';
import type { ConnectResult } from '@xcg/shared/config';

import { runConfigAddRemote, type ConfigHandlerOptions } from './config-handlers.js';
import type { LoginOutcome, LoginProcessOptions } from './login-runner.js';

export interface ConnectHandlerDeps {
  /** Runs the interactive login process (real: runLoginProcess). */
  login: (opts: LoginProcessOptions) => Promise<LoginOutcome>;
}

export interface ConnectConfig {
  readonly configPath: string;
  /** command written into the bridge entry (resolveXcgPathFromMain). */
  readonly xcgPath: string;
  /** binary to spawn for the login process (resolveXcgTargetPathFromMain). */
  readonly proxyBinPath: string;
  readonly name: string;
  readonly url: string;
  readonly timeoutMs: number;
}

export async function runConfigConnect(
  deps: ConnectHandlerDeps,
  config: ConnectConfig,
): Promise<ConnectResult> {
  // (1) name-exists pre-check, BEFORE the login (do not open the browser if the
  //     name is already taken). parseConfig errors propagate as IpcConfigError.
  const parsed = parseConfig(config.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') return { ok: false, error: { kind: 'not-found' } };
    return { ok: false, error: { kind: parsed.error.kind, detail: parsed.error.detail } };
  }
  const mcp =
    parsed.raw &&
    typeof parsed.raw === 'object' &&
    'mcpServers' in parsed.raw &&
    parsed.raw.mcpServers &&
    typeof parsed.raw.mcpServers === 'object'
      ? (parsed.raw.mcpServers as Record<string, unknown>)
      : {};
  if (config.name in mcp) {
    return { ok: false, error: { kind: 'name-exists', detail: 'A connector with that name already exists.' } };
  }

  // (2) Login. The only seam. If not success → error WITHOUT touching the config.
  const outcome = await deps.login({
    proxyBinPath: config.proxyBinPath,
    url: config.url,
    name: config.name,
    timeoutMs: config.timeoutMs,
  });
  if (outcome.kind === 'invalid-args') {
    return { ok: false, error: { kind: 'login-invalid-args', detail: outcome.detail } };
  }
  if (outcome.kind === 'failed') {
    return { ok: false, error: { kind: 'login-failed', detail: outcome.detail } };
  }

  // (3) Login OK → write the entry, reusing runConfigAddRemote
  //     (parseConfig + addRemoteToConfig + writeAtomic).
  const opts: ConfigHandlerOptions = { configPath: config.configPath, xcgPath: config.xcgPath };
  const added = runConfigAddRemote(opts, { name: config.name, url: config.url });
  if (!added.ok) return added;
  return { ok: true, op: 'connect', configPath: config.configPath, name: config.name, outcome: 'wrote' };
}
