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

import { isHttpUrl, isSafeRemoteName, parseConfig, toConnectors } from '@xcg/shared/config';
import type { ConnectResult } from '@xcg/shared/config';

import {
  entryToIpc,
  runConfigAddRemote,
  runConfigReplaceRemote,
  type ConfigHandlerOptions,
} from './config-handlers.js';
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
  /** Optional OAuth scopes forwarded to the login process (Gmail needs them;
   *  DCR connectors omit it). */
  readonly scope?: string;
  readonly timeoutMs: number;
}

export async function runConfigConnect(
  deps: ConnectHandlerDeps,
  config: ConnectConfig,
): Promise<ConnectResult> {
  // (0) Validate name and URL BEFORE the login (F4-01). Step (3) re-validates
  //     on write, but by then the login has completed a full OAuth dance and
  //     stored Keychain items under the RAW name — if the write then rejects,
  //     those credentials are orphaned under an account no Remove can reach
  //     (there is no config entry). Fulfils parser.ts's promise that names are
  //     validated before they reach the Keychain CLI or the args array; same
  //     typed errors the write step produces, so the existing banner mapping
  //     applies unchanged.
  if (!isSafeRemoteName(config.name)) {
    return {
      ok: false,
      error: { kind: 'invalid-name', detail: 'Name must be 1-64 chars: letters, digits, dot, underscore, hyphen.' },
    };
  }
  if (!isHttpUrl(config.url)) {
    return {
      ok: false,
      error: { kind: 'invalid-url', detail: 'The server URL must be a valid http(s) URL.' },
    };
  }

  // (1) Classify any existing entry of this name using the SAME mapping the
  //     Connectors UI uses (parser plan → entryToIpc → toConnectors), so
  //     "ours with this URL" is not a parallel criterion. All BEFORE the login:
  //     we only open the browser for a fresh connect or a legit reconnect.
  //     parseConfig errors propagate as IpcConfigError.
  const parsed = parseConfig(config.configPath);
  if (!parsed.ok) {
    if (parsed.error.kind === 'not-found') return { ok: false, error: { kind: 'not-found' } };
    return { ok: false, error: { kind: parsed.error.kind, detail: parsed.error.detail } };
  }
  const existing = parsed.plan.entries.find((e) => e.name === config.name);
  let reconnecting = false;
  if (existing !== undefined) {
    const [connector] = toConnectors([entryToIpc(existing)]);
    // Ours iff the classifier calls it a remote bridge (already-wrapped http);
    // reconnect only when the audited endpoint matches the requested URL.
    const oursSameUrl =
      connector !== undefined &&
      connector.type === 'remote' &&
      connector.endpoint === config.url;
    if (!oursSameUrl) {
      return { ok: false, error: { kind: 'name-exists', detail: 'A connector with that name already exists.' } };
    }
    reconnecting = true;
  }

  // (2) Login. The only seam. For a reconnect this re-auths an existing entry;
  //     for a fresh connect it authorizes a new one. On failure we touch
  //     nothing — the existing entry, if any, stays valid (login-first, no rollback).
  const outcome = await deps.login({
    proxyBinPath: config.proxyBinPath,
    url: config.url,
    name: config.name,
    scope: config.scope,
    timeoutMs: config.timeoutMs,
  });
  if (outcome.kind === 'invalid-args') {
    return { ok: false, error: { kind: 'login-invalid-args', detail: outcome.detail } };
  }
  if (outcome.kind === 'failed') {
    return { ok: false, error: { kind: 'login-failed', detail: outcome.detail } };
  }

  // (3) Login OK → write. Reconnect overwrites the existing bridge (normalizing
  //     its command path); a fresh connect inserts a new entry.
  const opts: ConfigHandlerOptions = { configPath: config.configPath, xcgPath: config.xcgPath };
  const written = reconnecting
    ? runConfigReplaceRemote(opts, { name: config.name, url: config.url })
    : runConfigAddRemote(opts, { name: config.name, url: config.url });
  if (!written.ok) return written;
  return {
    ok: true,
    op: 'connect',
    configPath: config.configPath,
    name: config.name,
    outcome: 'wrote',
    reconnected: reconnecting,
  };
}
