// Tests for the xcg-config CLI handlers (Milestone 4 Phase 4.3).
// Tests the pure runStatus/runInstall/runUninstall functions directly,
// not the bundled binary. Each test isolates IO under mkdtempSync so the
// real claude_desktop_config.json on the user's machine is never touched.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runStatus,
  runInstall,
  runUninstall,
  resolveXcgPath,
  type RunOptions,
} from '../../src/config/cli.js';

const FAKE_XCG = '/fake/path/to/xcg-proxy';

describe('xcg-config CLI handlers (Milestone 4 Phase 4.3)', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-config-cli-test-'));
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

  function opts(): RunOptions {
    return { configPath, xcgPath: FAKE_XCG };
  }

  // --- runStatus ---

  describe('runStatus', () => {
    it('returns config_present:false with exit 0 when config does not exist', () => {
      const result = runStatus(opts());
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        schema: 1,
        ok: true,
        config_present: false,
        entries: [],
        summary: { wrappable: 0, already_wrapped: 0, skipped_other: 0 },
      });
    });

    it('returns config_present:true with empty summary when config has no mcpServers', () => {
      writeConfig({});
      const result = runStatus(opts());
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        ok: true,
        config_present: true,
        entries: [],
        summary: { wrappable: 0, already_wrapped: 0, skipped_other: 0 },
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
      const result = runStatus(opts());
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        ok: true,
        config_present: true,
        summary: { wrappable: 1, already_wrapped: 0, skipped_other: 0 },
      });
    });

    it('reports already_wrapped when MCP is already pointing at xcg-proxy', () => {
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
      const result = runStatus(opts());
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        summary: { wrappable: 0, already_wrapped: 1, skipped_other: 0 },
      });
    });

    it('reports skipped (no-command) when MCP entry lacks command', () => {
      writeConfig({
        mcpServers: {
          broken: { args: ['something'] },
        },
      });
      const result = runStatus(opts());
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        summary: { wrappable: 0, already_wrapped: 0, skipped_other: 1 },
      });
    });

    it('returns exit 2 for corrupt JSON', () => {
      writeConfig('{not valid json}');
      const result = runStatus(opts());
      expect(result.exitCode).toBe(2);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { kind: 'invalid-json' },
      });
    });
  });

  // --- runInstall ---

  describe('runInstall', () => {
    it('returns exit 1 with not-found when config does not exist (dry-run)', () => {
      const result = runInstall(opts(), 'dry-run');
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { kind: 'not-found' },
      });
    });

    it('returns exit 1 with not-found when config does not exist (yes)', () => {
      const result = runInstall(opts(), 'yes');
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { kind: 'not-found' },
      });
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
      const result = runInstall(opts(), 'dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        ok: true,
        mode: 'dry-run',
        outcome: 'would_write',
      });
      // Config NOT modified.
      expect(readConfigParsed()).toEqual(original);
      // No backup created in dry-run.
      expect(existsSync(`${configPath}.bak`)).toBe(false);
    });

    it('dry-run: outcome noop when nothing wrappable', () => {
      writeConfig({ mcpServers: {} });
      const result = runInstall(opts(), 'dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
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

      const result = runInstall(opts(), 'yes');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        ok: true,
        mode: 'yes',
        outcome: 'wrote',
      });

      // Backup exists with original content.
      expect(existsSync(`${configPath}.bak`)).toBe(true);
      const bakContent = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'));
      expect(bakContent).toEqual(original);

      // Config now has the wrapped command.
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

    it('yes: idempotent — second install is noop, does NOT overwrite .bak', () => {
      const original = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(original);

      // First install: wrote
      const r1 = runInstall(opts(), 'yes');
      expect(r1.payload).toMatchObject({ outcome: 'wrote' });

      // Capture .bak content + mtime BEFORE second install.
      const bakBefore = readFileSync(`${configPath}.bak`, 'utf8');

      // Modify the config manually between installs (simulating user edit
      // post-install — this state should not be the .bak content).
      // Actually skip this; just run install again and verify noop.

      // Second install: noop
      const r2 = runInstall(opts(), 'yes');
      expect(r2.payload).toMatchObject({ outcome: 'noop' });

      // .bak content unchanged: first-write-wins preserved.
      const bakAfter = readFileSync(`${configPath}.bak`, 'utf8');
      expect(bakAfter).toBe(bakBefore);
    });

    it('yes: preserves user changes — .bak is the pre-xCLAUDE original, not the latest pre-install state', () => {
      // Initial state.
      const v1 = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(v1);

      // First install: wraps filesystem.
      runInstall(opts(), 'yes');

      // .bak now has v1 (the pre-xCLAUDE state).
      const bakAfterFirst = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'));
      expect(bakAfterFirst).toEqual(v1);

      // User adds a new unwrapped MCP entry manually (simulating editing the
      // wrapped config to add another server).
      const wrapped = readConfigParsed() as { mcpServers: Record<string, unknown> };
      wrapped.mcpServers.newServer = {
        command: '/some/other/bin',
        args: ['arg1'],
      };
      writeConfig(wrapped);

      // Second install: wraps the new server.
      runInstall(opts(), 'yes');

      // .bak STILL has the v1 original, untouched.
      const bakAfterSecond = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'));
      expect(bakAfterSecond).toEqual(v1);
    });

    it('returns exit 2 for corrupt JSON', () => {
      writeConfig('{not valid json}');
      const result = runInstall(opts(), 'yes');
      expect(result.exitCode).toBe(2);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { kind: 'invalid-json' },
      });
    });
  });

  // --- runUninstall ---

  describe('runUninstall', () => {
    it('returns exit 1 with not-found when config does not exist', () => {
      const result = runUninstall(opts(), 'yes');
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { kind: 'not-found' },
      });
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
      const result = runUninstall(opts(), 'dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
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
      const result = runUninstall(opts(), 'dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({ outcome: 'noop' });
    });

    it('yes: unwraps the config, preserves .bak from before install', () => {
      const original = {
        mcpServers: {
          filesystem: {
            command: '/usr/local/bin/npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      };
      writeConfig(original);

      // Install first.
      runInstall(opts(), 'yes');
      expect(existsSync(`${configPath}.bak`)).toBe(true);

      // Now uninstall.
      const result = runUninstall(opts(), 'yes');
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({ outcome: 'wrote' });

      // Config now has the unwrapped form.
      const written = readConfigParsed() as {
        mcpServers: { filesystem: { command: string; args: string[] } };
      };
      expect(written.mcpServers.filesystem.command).toBe('/usr/local/bin/npx');
      expect(written.mcpServers.filesystem.args).toEqual([
        '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
      ]);

      // .bak still exists with the original (pre-install) state.
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
      runInstall(opts(), 'yes');
      runUninstall(opts(), 'yes');

      const r2 = runUninstall(opts(), 'yes');
      expect(r2.payload).toMatchObject({ outcome: 'noop' });
    });
  });

  // --- resolveXcgPath ---

  describe('resolveXcgPath', () => {
    it('returns the stable symlink path when bundle is inside an .app', () => {
      const bundlePath = '/Applications/xCLAUDE Gateway.app/Contents/Resources/proxy/dist/xcg-config.cjs';
      const xcgPath = resolveXcgPath(bundlePath);
      expect(xcgPath).toMatch(/Library\/Application Support\/xCLAUDE Gateway\/bin\/xcg-proxy$/);
    });

    it('returns the sibling bin/xcg-proxy in dev mode', () => {
      const bundlePath = '/Users/dev/repo/packages/proxy/dist/xcg-config.cjs';
      const xcgPath = resolveXcgPath(bundlePath);
      expect(xcgPath).toBe('/Users/dev/repo/packages/proxy/bin/xcg-proxy');
    });

    it('treats empty bundle path as dev (resolves to ../bin/xcg-proxy relative to CWD)', () => {
      const xcgPath = resolveXcgPath('');
      // Should not throw; the resulting path is well-formed.
      expect(typeof xcgPath).toBe('string');
      expect(xcgPath.endsWith('bin/xcg-proxy')).toBe(true);
    });
  });
});
