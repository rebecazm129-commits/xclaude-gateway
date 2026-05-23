/**
 * Health handlers for the Setup tab indicator and the self-healing flow.
 *
 * Decided in C4.0 (Notion ficha 369242b46fa7817184cec3d0a0ce4647).
 * Implemented in C4.B (this file).
 *
 * Three FS-side checks decide the aggregate status:
 *   - 'symlink': the stable launcher path resolves to an existing target
 *   - 'config':  claude_desktop_config.json is present and parseable
 *   - 'wraps':   every wrap in the config points to an existing binary
 *
 * Pure functions — no electron app access here. The IPC wiring in C4.C
 * composes these with resolveXcgPathFromMain() and the canonical config
 * path, mirroring the pattern in config-handlers.ts (F5.1 C2).
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import {
  type HealthCheckResult,
  type HealthResult,
  type BrokenWrapDetail,
} from '@xcg/shared';
import {
  STABLE_XCG_PROXY_PATH,
  parseConfig,
  isAlreadyWrapped,
  type ParseResult,
} from '@xcg/shared/config';

export interface HealthHandlerOptions {
  /** Absolute path to claude_desktop_config.json. */
  configPath: string;
  /** Target that the stable symlink is expected to point at. Used by runRepairWraps in C4.B.2; runValidateHealth includes it for signature consistency but does not check the target identity. */
  xcgPath: string;
  /** Override for the stable symlink path. Production omits this and uses STABLE_XCG_PROXY_PATH; tests inject a tmpdir-scoped path. */
  symlinkPath?: string;
}

/**
 * Check 1 — the stable launcher symlink exists and resolves to a real target.
 */
function checkSymlink(symlinkPath: string): HealthCheckResult {
  let stat;
  try {
    stat = lstatSync(symlinkPath);
  } catch {
    return {
      check: 'symlink',
      status: 'fail',
      reason: 'stable launcher path missing',
    };
  }
  if (!stat.isSymbolicLink()) {
    return {
      check: 'symlink',
      status: 'fail',
      reason: 'stable launcher path exists but is not a symlink',
    };
  }
  let target: string;
  try {
    target = readlinkSync(symlinkPath);
  } catch {
    return {
      check: 'symlink',
      status: 'fail',
      reason: 'stable launcher symlink could not be read',
    };
  }
  if (!existsSync(target)) {
    return {
      check: 'symlink',
      status: 'fail',
      reason: 'stable launcher symlink resolves to a missing target',
    };
  }
  return { check: 'symlink', status: 'ok' };
}

/**
 * Check 2 — claude_desktop_config.json is present and parseable.
 * Returns both the structured check result AND the parsed config for reuse
 * by the wraps check (avoids parsing twice).
 */
function checkConfig(configPath: string): {
  result: HealthCheckResult;
  parsed: ParseResult | null;
} {
  const parsed = parseConfig(configPath);
  if (!parsed.ok) {
    let reason: string;
    switch (parsed.error.kind) {
      case 'not-found':
        reason = 'claude_desktop_config.json not found';
        break;
      case 'unreadable':
        reason = 'config could not be read (permission denied or I/O error)';
        break;
      case 'invalid-json':
        reason = 'config is not valid JSON';
        break;
      case 'unexpected-shape':
        reason = 'config has invalid structure';
        break;
    }
    return {
      result: { check: 'config', status: 'fail', reason },
      parsed: null,
    };
  }
  return {
    result: { check: 'config', status: 'ok' },
    parsed,
  };
}

/**
 * Type guard: a raw mcpServers entry has command (string) + args (string array).
 * Defensive: configs edited by hand may have unexpected shapes; the health
 * check must diagnose problems, not crash on them.
 */
function isWrapShape(value: unknown): value is { command: string; args: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { command?: unknown; args?: unknown };
  if (typeof v.command !== 'string') return false;
  if (!Array.isArray(v.args)) return false;
  if (!v.args.every((a) => typeof a === 'string')) return false;
  return true;
}

/**
 * Check 3 — every wrap in the config points to an existing binary.
 * Iterates parsed.raw.mcpServers directly (a single pass) and applies
 * isAlreadyWrapped to detect our own wraps. Non-wrap entries are
 * deliberately ignored: the user's own MCP commands are not our
 * responsibility to validate.
 */
function checkWraps(parsed: ParseResult): HealthCheckResult {
  if (!parsed.ok) {
    return { check: 'wraps', status: 'skip', reason: 'config check failed' };
  }
  const raw = parsed.raw;
  if (typeof raw !== 'object' || raw === null) {
    return { check: 'wraps', status: 'ok' };
  }
  const mcpServers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null) {
    return { check: 'wraps', status: 'ok' };
  }
  const broken: BrokenWrapDetail[] = [];
  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!isWrapShape(entry)) continue;
    if (!isAlreadyWrapped(entry.command, entry.args)) continue;
    if (!existsSync(entry.command)) {
      broken.push({ name, command: entry.command });
    }
  }
  if (broken.length === 0) {
    return { check: 'wraps', status: 'ok' };
  }
  return {
    check: 'wraps',
    status: 'fail',
    reason: 'one or more wraps point to missing binaries',
    details: broken,
  };
}

/**
 * Run the three FS-side checks and aggregate to a ternary status.
 * C4.1 emits only 'healthy' and 'unhealthy'; 'degraded' is reserved for
 * future post-MVP checks documented in the C4.0 ficha.
 */
export function runValidateHealth(opts: HealthHandlerOptions): HealthResult {
  void opts.xcgPath;
  const symlinkPath = opts.symlinkPath ?? STABLE_XCG_PROXY_PATH;
  const checks: HealthCheckResult[] = [];
  checks.push(checkSymlink(symlinkPath));
  const { result: configResult, parsed } = checkConfig(opts.configPath);
  checks.push(configResult);
  checks.push(parsed ? checkWraps(parsed) : { check: 'wraps', status: 'skip', reason: 'config check failed' });
  const anyFail = checks.some((c) => c.status === 'fail');
  return {
    status: anyFail ? 'unhealthy' : 'healthy',
    checks,
    checkedAt: new Date().toISOString(),
  };
}
