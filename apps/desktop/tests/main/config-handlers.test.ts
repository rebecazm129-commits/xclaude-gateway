// Tests for the config IPC handlers (Milestone 4 Phase 5.1 sub-step C2).
// Tests the pure runConfigStatus/runConfigInstall/runConfigUninstall functions
// directly, not the ipcMain.handle wrappers (those are thin and tested by the
// end-to-end smoke in sub-step E). Each test isolates IO under mkdtempSync so
// the real ~/Library/Application Support/Claude/claude_desktop_config.json on
// the user's machine is never touched.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runConfigAddRemote,
  runConfigInstall,
  runConfigIsConnected,
  runConfigRemoveRemote,
  runConfigStatus,
  runConfigUninstall,
  type ConfigHandlerOptions,
} from '../../src/main/config-handlers.js';

const FAKE_XCG = '/fake/path/to/xcg-proxy';

describe('config IPC handlers (Milestone 4 Phase 5.1 sub-step C2)', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-ipc-handlers-test-'));
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

  function opts(): ConfigHandlerOptions {
    return { configPath, xcgPath: FAKE_XCG };
  }

  // --- runConfigStatus ---

  describe('runConfigStatus', () => {
    it('returns configPresent:false (OK) when config does not exist', () => {
      const result = runConfigStatus(opts());
      expect(result).toEqual({
        ok: true,
        configPresent: false,
        configPath,
        entries: [],
        summary: { wrappable: 0, alreadyWrapped: 0, skippedOther: 0 },
      });
    });

    it('returns configPresent:true with empty summary when config has no mcpServers', () => {
      writeConfig({});
      const result = runConfigStatus(opts());
      expect(result).toMatchObject({
        ok: true,
        configPresent: true,
        configPath,
        summary: { wrappable: 0, alreadyWrapped: 0, skippedOther: 0 },
      });
    });

    it('reports wrappable entries when MCPs are unwrapped', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      });
      const result = runConfigStatus(opts());
      expect(result).toMatchObject({
        ok: true,
        configPresent: true,
        summary: { wrappable: 1, alreadyWrapped: 0, skippedOther: 0 },
      });
      // The entry list uses camelCase IpcConfigEntry shape (no nested original).
      if (result.ok) {
        expect(result.entries).toEqual([
          { kind: 'wrappable', name: 'filesystem', transport: 'stdio', endpoint: '/usr/local/bin/npx' },
        ]);
      }
    });

    it('reports alreadyWrapped (camelCase) when MCP is already wrapped', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: '/fake/path/to/xcg-proxy',
            args: [
              '--wrap', '/usr/local/bin/npx',
              '--name', 'filesystem',
              '--',
              '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
            ],
          },
        },
      });
      const result = runConfigStatus(opts());
      expect(result).toMatchObject({
        ok: true,
        summary: { wrappable: 0, alreadyWrapped: 1, skippedOther: 0 },
      });
    });

    it('reports skippedOther (camelCase) when MCP lacks command', () => {
      writeConfig({
        mcpServers: {
          broken: { args: ['something'] },
        },
      });
      const result = runConfigStatus(opts());
      expect(result).toMatchObject({
        summary: { wrappable: 0, alreadyWrapped: 0, skippedOther: 1 },
      });
    });

    it('returns ok:false with error.kind for corrupt JSON', () => {
      writeConfig('{not valid json}');
      const result = runConfigStatus(opts());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid-json');
      }
    });
  });

  // --- runConfigInstall ---

  describe('runConfigInstall', () => {
    it('returns ok:false with unreadable+detail when config does not exist (dry-run)', () => {
      const result = runConfigInstall(opts(), 'dry-run');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('unreadable');
        // not-found in install maps to unreadable in IPC (decision: install
        // requires the config to exist; renderer surfaces a helpful message).
      }
    });

    it('returns ok:false with unreadable+detail when config does not exist (yes)', () => {
      const result = runConfigInstall(opts(), 'yes');
      expect(result.ok).toBe(false);
    });

    it('dry-run: outcome would_write, does NOT touch the config', () => {
      const original = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(original);
      const result = runConfigInstall(opts(), 'dry-run');
      expect(result).toMatchObject({
        ok: true,
        mode: 'dry-run',
        outcome: 'would_write',
      });
      // Config NOT modified.
      expect(readConfigParsed()).toEqual(original);
      // No backup in dry-run.
      expect(existsSync(`${configPath}.bak`)).toBe(false);
    });

    it('dry-run: outcome noop when nothing wrappable', () => {
      writeConfig({ mcpServers: {} });
      const result = runConfigInstall(opts(), 'dry-run');
      expect(result).toMatchObject({
        ok: true,
        mode: 'dry-run',
        outcome: 'noop',
      });
    });

    it('yes: writes wrapped config, creates .bak, outcome wrote', () => {
      const original = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(original);

      const result = runConfigInstall(opts(), 'yes');
      expect(result).toMatchObject({
        ok: true,
        mode: 'yes',
        outcome: 'wrote',
      });

      // Backup with original.
      expect(existsSync(`${configPath}.bak`)).toBe(true);
      const bakContent = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'));
      expect(bakContent).toEqual(original);

      // Config wrapped.
      const written = readConfigParsed() as {
        mcpServers: { filesystem: { command: string; args: string[] } };
      };
      expect(written.mcpServers.filesystem.command).toBe(FAKE_XCG);
      expect(written.mcpServers.filesystem.args).toEqual([
        'stdio',
        '--wrap', '/usr/local/bin/npx',
        '--name', 'filesystem',
        '--',
        '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
      ]);
    });

    it('yes: idempotent — second install is noop, .bak first-write-wins preserved', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      });

      runConfigInstall(opts(), 'yes');
      const bakBefore = readFileSync(`${configPath}.bak`, 'utf8');

      const r2 = runConfigInstall(opts(), 'yes');
      expect(r2).toMatchObject({ outcome: 'noop' });

      const bakAfter = readFileSync(`${configPath}.bak`, 'utf8');
      expect(bakAfter).toBe(bakBefore);
    });

    it('returns ok:false for corrupt JSON', () => {
      writeConfig('{not valid json}');
      const result = runConfigInstall(opts(), 'yes');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid-json');
      }
    });
  });

  // --- runConfigInstall: only (single-connector wrap) ---

  describe('runConfigInstall — only (single connector)', () => {
    it('yes + only=<wrappable>: wraps only that entry, leaves the other wrappable untouched', () => {
      writeConfig({
        mcpServers: {
          a: { command: '/usr/local/bin/npx', args: ['-y', 'srv-a'] },
          b: { command: 'node', args: ['b.js'] },
        },
      });

      const result = runConfigInstall(opts(), 'yes', 'a');
      expect(result).toMatchObject({ ok: true, mode: 'yes', outcome: 'wrote' });

      const written = readConfigParsed() as {
        mcpServers: {
          a: { command: string; args: string[] };
          b: { command: string; args: string[] };
        };
      };
      // 'a' is wrapped with the exact contract.
      expect(written.mcpServers.a.command).toBe(FAKE_XCG);
      expect(written.mcpServers.a.args).toEqual([
        'stdio',
        '--wrap', '/usr/local/bin/npx',
        '--name', 'a',
        '--',
        '-y', 'srv-a',
      ]);
      // 'b', though wrappable, is left byte-for-byte.
      expect(written.mcpServers.b).toEqual({ command: 'node', args: ['b.js'] });
    });

    it('yes + only=<inexistent name>: noop, nothing written, no .bak', () => {
      writeConfig({
        mcpServers: { a: { command: 'npx', args: ['-y', 'a'] } },
      });
      const before = readConfigParsed();

      const result = runConfigInstall(opts(), 'yes', 'zzz');
      expect(result).toMatchObject({ outcome: 'noop' });

      expect(readConfigParsed()).toEqual(before);            // config untouched
      expect(existsSync(`${configPath}.bak`)).toBe(false);   // never wrote
    });

    it('yes + only=<already-wrapped name>: noop, config unchanged', () => {
      writeConfig({
        mcpServers: { a: { command: 'npx', args: ['-y', 'a'] } },
      });
      runConfigInstall(opts(), 'yes');         // wrap 'a' first
      const afterFirst = readConfigParsed();

      const r2 = runConfigInstall(opts(), 'yes', 'a'); // 'a' now already-wrapped → not wrappable
      expect(r2).toMatchObject({ outcome: 'noop' });
      expect(readConfigParsed()).toEqual(afterFirst);
    });

    it('dry-run + only=<wrappable>: would_write, nothing written', () => {
      writeConfig({
        mcpServers: {
          a: { command: 'npx', args: ['-y', 'a'] },
          b: { command: 'node', args: ['b.js'] },
        },
      });
      const result = runConfigInstall(opts(), 'dry-run', 'a');
      expect(result).toMatchObject({ outcome: 'would_write' });
      expect(existsSync(`${configPath}.bak`)).toBe(false);
    });

    it('dry-run + only=<non-wrappable>: noop', () => {
      writeConfig({
        mcpServers: { a: { command: 'npx', args: ['-y', 'a'] } },
      });
      const result = runConfigInstall(opts(), 'dry-run', 'zzz');
      expect(result).toMatchObject({ outcome: 'noop' });
    });
  });

  // --- runConfigUninstall ---

  describe('runConfigUninstall', () => {
    it('returns ok:false with unreadable+detail when config does not exist', () => {
      const result = runConfigUninstall(opts(), 'yes');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('unreadable');
      }
    });

    it('dry-run: outcome would_write when MCPs are wrapped', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: FAKE_XCG,
            args: [
              '--wrap', '/usr/local/bin/npx',
              '--name', 'filesystem',
              '--',
              '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
            ],
          },
        },
      });
      const result = runConfigUninstall(opts(), 'dry-run');
      expect(result).toMatchObject({
        ok: true,
        mode: 'dry-run',
        outcome: 'would_write',
      });
    });

    it('dry-run: outcome noop when nothing wrapped', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['something'],
          },
        },
      });
      const result = runConfigUninstall(opts(), 'dry-run');
      expect(result).toMatchObject({ outcome: 'noop' });
    });

    it('yes: unwraps, preserves .bak from before install', () => {
      const original = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(original);

      runConfigInstall(opts(), 'yes');
      expect(existsSync(`${configPath}.bak`)).toBe(true);

      const result = runConfigUninstall(opts(), 'yes');
      expect(result).toMatchObject({ outcome: 'wrote' });

      const written = readConfigParsed() as {
        mcpServers: { filesystem: { command: string; args: string[] } };
      };
      expect(written.mcpServers.filesystem.command).toBe('/usr/local/bin/npx');

      // .bak still here.
      expect(existsSync(`${configPath}.bak`)).toBe(true);
      const bakContent = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'));
      expect(bakContent).toEqual(original);
    });

    it('yes: idempotent — second uninstall is noop', () => {
      writeConfig({
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      });
      runConfigInstall(opts(), 'yes');
      runConfigUninstall(opts(), 'yes');

      const r2 = runConfigUninstall(opts(), 'yes');
      expect(r2).toMatchObject({ outcome: 'noop' });
    });
  });

  // --- runConfigAddRemote (Hito 6 Fase 5) ---

  describe('runConfigAddRemote', () => {
    const URL_OK = 'https://mcp.notion.com/mcp';

    it('adds a remote bridge entry, outcome wrote', () => {
      writeConfig({
        mcpServers: {
          filesystem: { command: '/usr/local/bin/npx', args: ['-y', 'fs'] },
        },
      });
      const result = runConfigAddRemote(opts(), { name: 'notion', url: URL_OK });
      expect(result).toMatchObject({ ok: true, op: 'add-remote', outcome: 'wrote' });

      const written = readConfigParsed() as {
        mcpServers: { notion: { command: string; args: string[] } };
      };
      expect(written.mcpServers.notion.command).toBe(FAKE_XCG);
      expect(written.mcpServers.notion.args).toEqual([
        'http', '--url', URL_OK, '--name', 'notion',
      ]);
    });

    it('rejects an invalid name', () => {
      writeConfig({ mcpServers: {} });
      const result = runConfigAddRemote(opts(), { name: 'bad name', url: URL_OK });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid-name');
    });

    it('rejects an invalid url', () => {
      writeConfig({ mcpServers: {} });
      const result = runConfigAddRemote(opts(), { name: 'notion', url: 'not-a-url' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid-url');
    });

    it('rejects a name that already exists', () => {
      writeConfig({
        mcpServers: { notion: { command: '/usr/local/bin/npx', args: ['-y', 'fs'] } },
      });
      const result = runConfigAddRemote(opts(), { name: 'notion', url: URL_OK });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('name-exists');
    });

    it('returns not-found when the config does not exist', () => {
      const result = runConfigAddRemote(opts(), { name: 'notion', url: URL_OK });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('not-found');
    });
  });

  // --- runConfigRemoveRemote (Hito 6 Fase 5) ---

  describe('runConfigRemoveRemote', () => {
    const URL_OK = 'https://mcp.notion.com/mcp';
    const deleteCredentials = vi.fn(() => Promise.resolve({ cleared: true }));

    beforeEach(() => {
      deleteCredentials.mockReset();
      deleteCredentials.mockResolvedValue({ cleared: true });
    });

    it('removes one of our remote entries, outcome wrote, clears credentials', async () => {
      writeConfig({ mcpServers: {} });
      runConfigAddRemote(opts(), { name: 'notion', url: URL_OK });

      const result = await runConfigRemoveRemote(opts(), { name: 'notion' }, { deleteCredentials });
      expect(result).toMatchObject({ ok: true, op: 'remove-remote', outcome: 'wrote', tokensCleared: true });
      expect(deleteCredentials).toHaveBeenCalledWith('notion');

      const written = readConfigParsed() as { mcpServers: Record<string, unknown> };
      expect('notion' in written.mcpServers).toBe(false);
    });

    it('does not remove a non-ours entry: outcome noop, entry stays, Keychain untouched', async () => {
      writeConfig({
        mcpServers: { notion: { command: '/usr/local/bin/npx', args: ['-y', 'fs'] } },
      });
      const result = await runConfigRemoveRemote(opts(), { name: 'notion' }, { deleteCredentials });
      expect(result).toMatchObject({ ok: true, op: 'remove-remote', outcome: 'noop' });
      expect(deleteCredentials).not.toHaveBeenCalled();

      const written = readConfigParsed() as {
        mcpServers: { notion: { command: string; args: string[] } };
      };
      expect(written.mcpServers.notion).toEqual({ command: '/usr/local/bin/npx', args: ['-y', 'fs'] });
    });

    it('non-existent name: outcome noop, Keychain untouched', async () => {
      writeConfig({ mcpServers: {} });
      const result = await runConfigRemoveRemote(opts(), { name: 'notion' }, { deleteCredentials });
      expect(result).toMatchObject({ ok: true, op: 'remove-remote', outcome: 'noop' });
      expect(deleteCredentials).not.toHaveBeenCalled();
    });

    it('wrote but credential clear fails: remove still ok, tokensCleared:false', async () => {
      writeConfig({ mcpServers: {} });
      runConfigAddRemote(opts(), { name: 'notion', url: URL_OK });
      deleteCredentials.mockResolvedValue({ cleared: false });

      const result = await runConfigRemoveRemote(opts(), { name: 'notion' }, { deleteCredentials });
      expect(result).toMatchObject({ ok: true, op: 'remove-remote', outcome: 'wrote', tokensCleared: false });
    });
  });

  // --- runConfigIsConnected (Hito 6 Fase 5, Pieza B) ---

  describe('runConfigIsConnected', () => {
    const URL_OK = 'https://mcp.notion.com/mcp';

    it('connected: true for our http connector', () => {
      writeConfig({
        mcpServers: {
          notion: { command: FAKE_XCG, args: ['http', '--url', URL_OK, '--name', 'notion'] },
        },
      });
      const result = runConfigIsConnected(opts(), { name: 'notion' });
      expect(result).toEqual({ ok: true, connected: true });
    });

    it('connected: false for our stdio wrap (ours but not http)', () => {
      writeConfig({
        mcpServers: {
          fs: { command: FAKE_XCG, args: ['stdio', '--wrap', '/usr/local/bin/npx', '--name', 'fs', '--', '-y', 'fs'] },
        },
      });
      const result = runConfigIsConnected(opts(), { name: 'fs' });
      expect(result).toEqual({ ok: true, connected: false });
    });

    it('connected: false for a foreign entry', () => {
      writeConfig({
        mcpServers: { notion: { command: 'npx', args: ['-y', 'foo'] } },
      });
      const result = runConfigIsConnected(opts(), { name: 'notion' });
      expect(result).toEqual({ ok: true, connected: false });
    });

    it('connected: false when the key is absent', () => {
      writeConfig({ mcpServers: { other: { command: 'npx' } } });
      const result = runConfigIsConnected(opts(), { name: 'notion' });
      expect(result).toEqual({ ok: true, connected: false });
    });

    it('config not-found: ok true, connected false (not an error)', () => {
      const result = runConfigIsConnected(opts(), { name: 'notion' });
      expect(result).toEqual({ ok: true, connected: false });
    });

    it('corrupt JSON: ok false, error.kind invalid-json', () => {
      writeConfig('{not valid json}');
      const result = runConfigIsConnected(opts(), { name: 'notion' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid-json');
    });
  });
});
