// Tests for the connect orchestrator (Hito 6 Fase 5, Pieza A). Combined pattern:
// a real config under mkdtempSync (like config-handlers.test.ts) + a mocked login
// seam (vi.fn()). No process is ever spawned. The mkdtempSync isolation keeps the
// user's real claude_desktop_config.json untouched.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runConfigConnect, type ConnectConfig } from '../../src/main/connect-handler.js';
import type { LoginOutcome } from '../../src/main/login-runner.js';

const FAKE_XCG = '/fake/path/to/xcg-proxy';
const URL_OK = 'https://mcp.notion.com/mcp';

describe('runConfigConnect (Hito 6 Fase 5, Pieza A)', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-connect-test-'));
    configPath = join(tmp, 'claude_desktop_config.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(content: object | string): void {
    writeFileSync(
      configPath,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }

  function readConfigParsed(): unknown {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }

  function cfg(name: string): ConnectConfig {
    return { configPath, xcgPath: FAKE_XCG, proxyBinPath: FAKE_XCG, name, url: URL_OK, timeoutMs: 1000 };
  }

  it('login success: writes the bridge entry', async () => {
    writeConfig({
      mcpServers: { filesystem: { command: '/usr/local/bin/npx', args: ['-y', 'fs'] } },
    });
    const login = vi.fn((): Promise<LoginOutcome> => Promise.resolve({ kind: 'success' }));

    const result = await runConfigConnect({ login }, cfg('notion'));
    expect(result).toMatchObject({ ok: true, op: 'connect', outcome: 'wrote' });
    expect(login).toHaveBeenCalledTimes(1);

    const written = readConfigParsed() as {
      mcpServers: { notion: { command: string; args: string[] } };
    };
    expect(written.mcpServers.notion.command).toBe(FAKE_XCG);
    expect(written.mcpServers.notion.args).toEqual([
      'http', '--url', URL_OK, '--name', 'notion',
    ]);
  });

  it('login failed: does not touch the config', async () => {
    writeConfig({ mcpServers: {} });
    const login = vi.fn((): Promise<LoginOutcome> => Promise.resolve({ kind: 'failed', detail: 'boom' }));

    const result = await runConfigConnect({ login }, cfg('notion'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('login-failed');

    const written = readConfigParsed() as { mcpServers: Record<string, unknown> };
    expect('notion' in written.mcpServers).toBe(false);
  });

  it('login invalid-args: error login-invalid-args, config intact', async () => {
    writeConfig({ mcpServers: {} });
    const login = vi.fn((): Promise<LoginOutcome> => Promise.resolve({ kind: 'invalid-args', detail: 'bad' }));

    const result = await runConfigConnect({ login }, cfg('notion'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('login-invalid-args');

    const written = readConfigParsed() as { mcpServers: Record<string, unknown> };
    expect('notion' in written.mcpServers).toBe(false);
  });

  it('name-exists short-circuits BEFORE the login', async () => {
    writeConfig({
      mcpServers: { notion: { command: '/usr/local/bin/npx', args: ['-y', 'fs'] } },
    });
    const login = vi.fn((): Promise<LoginOutcome> => Promise.resolve({ kind: 'success' }));

    const result = await runConfigConnect({ login }, cfg('notion'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('name-exists');
    expect(login).not.toHaveBeenCalled();
  });

  it('config not-found: error not-found, login not called', async () => {
    const login = vi.fn((): Promise<LoginOutcome> => Promise.resolve({ kind: 'success' }));

    const result = await runConfigConnect({ login }, cfg('notion'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
    expect(login).not.toHaveBeenCalled();
  });
});
