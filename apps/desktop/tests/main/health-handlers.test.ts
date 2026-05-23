import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runValidateHealth,
  type HealthHandlerOptions,
} from '../../src/main/health-handlers.js';

describe('runValidateHealth (Milestone 5 Component 4 step B.1)', () => {
  let tmp: string;
  let configPath: string;
  let symlinkPath: string;
  let xcgTargetPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-health-test-'));
    configPath = join(tmp, 'claude_desktop_config.json');
    symlinkPath = join(tmp, 'xcg-proxy-link');
    xcgTargetPath = join(tmp, 'xcg-proxy-real');
    writeFileSync(xcgTargetPath, '#!/bin/sh\necho ok\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeSymlink(target: string = xcgTargetPath): void {
    symlinkSync(target, symlinkPath);
  }

  function writeConfig(content: unknown): void {
    writeFileSync(configPath, JSON.stringify(content, null, 2));
  }

  function writeWrappedConfig(wraps: Array<{ name: string; command: string }>): void {
    const mcpServers: Record<string, { command: string; args: string[] }> = {};
    for (const w of wraps) {
      mcpServers[w.name] = {
        command: w.command,
        args: ['--wrap', '/usr/local/bin/npx', '--name', w.name, '--', '-y', 'somepkg'],
      };
    }
    writeConfig({ mcpServers });
  }

  function opts(): HealthHandlerOptions {
    return { configPath, xcgPath: xcgTargetPath, symlinkPath };
  }

  function makeFakeXcgBinary(name: string = 'xcg-proxy'): string {
    const p = join(tmp, name);
    writeFileSync(p, '#!/bin/sh\necho ok\n');
    return p;
  }

  it('1. green path: symlink ok + config ok + wraps ok → healthy', () => {
    makeSymlink();
    const fakeXcg = makeFakeXcgBinary();
    writeWrappedConfig([{ name: 'filesystem', command: fakeXcg }]);
    const result = runValidateHealth(opts());
    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('2. symlink missing → unhealthy, symlink check fails', () => {
    writeConfig({ mcpServers: {} });
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const symlinkCheck = result.checks.find((c) => c.check === 'symlink');
    expect(symlinkCheck?.status).toBe('fail');
    if (symlinkCheck?.status === 'fail') {
      expect(symlinkCheck.reason).toContain('missing');
    }
  });

  it('3. symlinkPath is a regular file not a symlink → unhealthy with specific reason', () => {
    writeFileSync(symlinkPath, 'not a symlink');
    writeConfig({ mcpServers: {} });
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const symlinkCheck = result.checks.find((c) => c.check === 'symlink');
    expect(symlinkCheck?.status).toBe('fail');
    if (symlinkCheck?.status === 'fail') {
      expect(symlinkCheck.reason).toContain('not a symlink');
    }
  });

  it('4. symlink target does not exist → unhealthy with specific reason', () => {
    symlinkSync(join(tmp, 'nonexistent'), symlinkPath);
    writeConfig({ mcpServers: {} });
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const symlinkCheck = result.checks.find((c) => c.check === 'symlink');
    expect(symlinkCheck?.status).toBe('fail');
    if (symlinkCheck?.status === 'fail') {
      expect(symlinkCheck.reason).toContain('missing target');
    }
  });

  it('5. config not present → unhealthy, wraps check skipped', () => {
    makeSymlink();
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const configCheck = result.checks.find((c) => c.check === 'config');
    expect(configCheck?.status).toBe('fail');
    const wrapsCheck = result.checks.find((c) => c.check === 'wraps');
    expect(wrapsCheck?.status).toBe('skip');
  });

  it('6. config not valid JSON → unhealthy, wraps check skipped', () => {
    makeSymlink();
    writeFileSync(configPath, '{not valid json');
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const configCheck = result.checks.find((c) => c.check === 'config');
    expect(configCheck?.status).toBe('fail');
    if (configCheck?.status === 'fail') {
      expect(configCheck.reason).toContain('JSON');
    }
    const wrapsCheck = result.checks.find((c) => c.check === 'wraps');
    expect(wrapsCheck?.status).toBe('skip');
  });

  it('7. config valid but 0 mcpServers → healthy, all 3 checks ok', () => {
    makeSymlink();
    writeConfig({ mcpServers: {} });
    const result = runValidateHealth(opts());
    expect(result.status).toBe('healthy');
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('8. config has 1 wrap pointing to existing binary → healthy', () => {
    makeSymlink();
    const fakeXcg = makeFakeXcgBinary();
    writeWrappedConfig([{ name: 'filesystem', command: fakeXcg }]);
    const result = runValidateHealth(opts());
    expect(result.status).toBe('healthy');
  });

  it('9. config has 1 wrap pointing to missing binary → unhealthy, details has 1 entry', () => {
    makeSymlink();
    writeWrappedConfig([{ name: 'filesystem', command: join(tmp, 'missing-dir', 'xcg-proxy') }]);
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const wrapsCheck = result.checks.find((c) => c.check === 'wraps');
    expect(wrapsCheck?.status).toBe('fail');
    if (wrapsCheck?.status === 'fail') {
      expect(wrapsCheck.details).toHaveLength(1);
      expect(wrapsCheck.details?.[0].name).toBe('filesystem');
    }
  });

  it('10. config has 2 wraps both missing → unhealthy, details has 2 entries', () => {
    makeSymlink();
    writeWrappedConfig([
      { name: 'filesystem', command: join(tmp, 'missing-1', 'xcg-proxy') },
      { name: 'everything', command: join(tmp, 'missing-2', 'xcg-proxy') },
    ]);
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const wrapsCheck = result.checks.find((c) => c.check === 'wraps');
    if (wrapsCheck?.status === 'fail') {
      expect(wrapsCheck.details).toHaveLength(2);
    }
  });

  it('11. config has 2 wraps, 1 ok 1 missing → unhealthy, details has only the missing one', () => {
    makeSymlink();
    const fakeXcg = makeFakeXcgBinary();
    writeWrappedConfig([
      { name: 'ok-wrap', command: fakeXcg },
      { name: 'broken-wrap', command: join(tmp, 'missing-dir', 'xcg-proxy') },
    ]);
    const result = runValidateHealth(opts());
    expect(result.status).toBe('unhealthy');
    const wrapsCheck = result.checks.find((c) => c.check === 'wraps');
    if (wrapsCheck?.status === 'fail') {
      expect(wrapsCheck.details).toHaveLength(1);
      expect(wrapsCheck.details?.[0].name).toBe('broken-wrap');
    }
  });

  it('12. config has 1 NON-wrap entry (not xcg shape) → wraps check ignores it', () => {
    makeSymlink();
    writeConfig({
      mcpServers: {
        filesystem: {
          command: '/usr/local/bin/npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    });
    const result = runValidateHealth(opts());
    expect(result.status).toBe('healthy');
  });

  it('13. checkedAt is a valid ISO string', () => {
    makeSymlink();
    writeConfig({ mcpServers: {} });
    const result = runValidateHealth(opts());
    expect(typeof result.checkedAt).toBe('string');
    expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });

  it('14. all three checks always present in result regardless of status', () => {
    const result = runValidateHealth(opts());
    expect(result.checks).toHaveLength(3);
    const checkIds = result.checks.map((c) => c.check).sort();
    expect(checkIds).toEqual(['config', 'symlink', 'wraps']);
  });
});
