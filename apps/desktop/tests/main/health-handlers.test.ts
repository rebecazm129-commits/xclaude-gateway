import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runValidateHealth,
  runRepairWraps,
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
    return { configPath, xcgTargetPath, symlinkPath };
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

describe('runRepairWraps (Milestone 5 Component 4 step B.2)', () => {
  let tmp: string;
  let configPath: string;
  let symlinkPath: string;
  let xcgTargetPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-repair-test-'));
    configPath = join(tmp, 'claude_desktop_config.json');
    symlinkPath = join(tmp, 'xcg-proxy-link');
    xcgTargetPath = join(tmp, 'xcg-proxy-real');
    writeFileSync(xcgTargetPath, '#!/bin/sh\necho ok\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(content: unknown): void {
    writeFileSync(configPath, JSON.stringify(content, null, 2));
  }

  function writeWrappedConfig(wraps: Array<{ name: string; command: string }>, extraTopLevel: Record<string, unknown> = {}): void {
    const mcpServers: Record<string, { command: string; args: string[] }> = {};
    for (const w of wraps) {
      mcpServers[w.name] = {
        command: w.command,
        args: ['--wrap', '/usr/local/bin/npx', '--name', w.name, '--', '-y', 'somepkg'],
      };
    }
    writeConfig({ ...extraTopLevel, mcpServers });
  }

  function opts(): HealthHandlerOptions {
    return { configPath, xcgTargetPath, symlinkPath };
  }

  function readConfig(): { mcpServers: Record<string, { command: string; args: string[] }>; [k: string]: unknown } {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }

  it('R1. no symlink, no broken wraps → creates symlink, no wraps repaired, healthy after', () => {
    writeConfig({ mcpServers: {} });
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.symlinkAction).toBe('created');
      expect(result.repairedWraps).toHaveLength(0);
      expect(result.newHealth.status).toBe('healthy');
    }
    expect(existsSync(symlinkPath)).toBe(true);
  });

  it('R2. symlink already correct, no broken wraps → unchanged symlink, no wraps repaired, healthy', () => {
    symlinkSync(xcgTargetPath, symlinkPath);
    writeConfig({ mcpServers: {} });
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.symlinkAction).toBe('unchanged');
      expect(result.repairedWraps).toHaveLength(0);
    }
  });

  it('R3. symlink points to wrong target → recreated, no wraps repaired, healthy after', () => {
    const wrongTarget = join(tmp, 'wrong-target');
    writeFileSync(wrongTarget, 'wrong');
    symlinkSync(wrongTarget, symlinkPath);
    writeConfig({ mcpServers: {} });
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.symlinkAction).toBe('recreated');
      expect(result.newHealth.status).toBe('healthy');
    }
  });

  it('R4. 1 broken wrap → rewrites it to symlinkPath, repairedWraps has 1, healthy after', () => {
    writeWrappedConfig([{ name: 'filesystem', command: join(tmp, 'missing-dir', 'xcg-proxy') }]);
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairedWraps).toEqual(['filesystem']);
      expect(result.newHealth.status).toBe('healthy');
    }
    const cfg = readConfig();
    expect(cfg.mcpServers.filesystem.command).toBe(symlinkPath);
  });

  it('R5. 2 broken wraps → rewrites both, repairedWraps has 2, healthy after', () => {
    writeWrappedConfig([
      { name: 'fs1', command: join(tmp, 'missing-1', 'xcg-proxy') },
      { name: 'fs2', command: join(tmp, 'missing-2', 'xcg-proxy') },
    ]);
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairedWraps.sort()).toEqual(['fs1', 'fs2']);
    }
    const cfg = readConfig();
    expect(cfg.mcpServers.fs1.command).toBe(symlinkPath);
    expect(cfg.mcpServers.fs2.command).toBe(symlinkPath);
  });

  it('R6. 1 broken + 1 OK → only the broken one is rewritten, OK preserved', () => {
    const okXcg = join(tmp, 'xcg-proxy');
    writeFileSync(okXcg, '#!/bin/sh\necho ok\n');
    writeWrappedConfig([
      { name: 'ok-wrap', command: okXcg },
      { name: 'broken-wrap', command: join(tmp, 'missing-dir', 'xcg-proxy') },
    ]);
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairedWraps).toEqual(['broken-wrap']);
    }
    const cfg = readConfig();
    expect(cfg.mcpServers['ok-wrap'].command).toBe(okXcg);
    expect(cfg.mcpServers['broken-wrap'].command).toBe(symlinkPath);
  });

  it('R7. non-wrap entries → untouched, preserved verbatim', () => {
    writeConfig({
      mcpServers: {
        filesystem: {
          command: '/usr/local/bin/npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    });
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairedWraps).toHaveLength(0);
    }
    const cfg = readConfig();
    expect(cfg.mcpServers.filesystem.command).toBe('/usr/local/bin/npx');
  });

  it('R8. wrap with existing command but NOT pointing to symlinkPath → left alone (criterio (b))', () => {
    // Wrap apunta a un xcg-proxy real pero no al symlink canonico.
    const directPath = join(tmp, 'xcg-proxy');
    writeFileSync(directPath, '#!/bin/sh\necho ok\n');
    writeWrappedConfig([{ name: 'filesystem', command: directPath }]);
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // criterio (b): no se canonicaliza un wrap funcional.
      expect(result.repairedWraps).toHaveLength(0);
    }
    const cfg = readConfig();
    expect(cfg.mcpServers.filesystem.command).toBe(directPath);
  });

  it('R9. config not found → ok: false with parse error message', () => {
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('parse config');
    }
  });

  it('R10. config invalid JSON → ok: false with parse error message', () => {
    writeFileSync(configPath, '{not valid json');
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('parse config');
    }
  });

  it('R11. idempotency: 2 consecutive calls, 2nd is no-op', () => {
    writeWrappedConfig([{ name: 'filesystem', command: join(tmp, 'missing-dir', 'xcg-proxy') }]);
    const r1 = runRepairWraps(opts());
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.repairedWraps).toEqual(['filesystem']);
    }
    const r2 = runRepairWraps(opts());
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      // El wrap ya apunta a symlinkPath; existsSync(symlinkPath) es true tras R1; no se reescribe.
      expect(r2.repairedWraps).toHaveLength(0);
      expect(r2.symlinkAction).toBe('unchanged');
    }
  });

  it('R12. args of repaired wrap are preserved verbatim + other top-level keys preserved', () => {
    writeWrappedConfig(
      [{ name: 'filesystem', command: join(tmp, 'missing-dir', 'xcg-proxy') }],
      { otherTopLevelKey: 'preserveMe', anotherKey: { nested: true } },
    );
    const result = runRepairWraps(opts());
    expect(result.ok).toBe(true);
    const cfg = readConfig();
    // command rewritten
    expect(cfg.mcpServers.filesystem.command).toBe(symlinkPath);
    // args preserved verbatim
    expect(cfg.mcpServers.filesystem.args).toEqual([
      '--wrap', '/usr/local/bin/npx', '--name', 'filesystem', '--', '-y', 'somepkg',
    ]);
    // top-level keys preserved
    expect((cfg as Record<string, unknown>).otherTopLevelKey).toBe('preserveMe');
    expect((cfg as Record<string, unknown>).anotherKey).toEqual({ nested: true });
  });

  it('regression C4.E.4: when xcgTargetPath equals symlinkPath, cycle guard fires (caller bug surfaces as cycle error)', () => {
    // Documents the bug discovered in C4.E.4 smoke: in production packaged
    // builds, the IPC handler had ensureSymlink(xcgPath, symlinkPath) where
    // both resolved to STABLE_XCG_PROXY_PATH. With the FIX.A signature
    // refactor, the caller now provides DISTINCT paths in production. If
    // any future caller regresses and passes the same path for both, the
    // FIX.C cycle guard in ensureSymlink rejects the call without touching
    // disk. This test pins that defense-in-depth behavior.
    const samePath = join(tmp, 'same-path');
    writeFileSync(samePath, '#!/bin/sh\necho ok\n');
    const cfgPath = join(tmp, 'cfg.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        foo: { command: samePath, args: ['arg'] },
      },
    }, null, 2));
    const result = runRepairWraps({
      configPath: cfgPath,
      xcgTargetPath: samePath,
      symlinkPath: samePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cycle');
    }
  });
});
