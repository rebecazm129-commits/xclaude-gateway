/**
 * Health domain types for the Setup tab indicator and the self-healing flow.
 *
 * Decided in C4.0 (Notion ficha 369242b46fa7817184cec3d0a0ce4647).
 * Implemented in C4.A (this file). Logic lives in C4.B
 * (apps/desktop/src/main/health-handlers.ts). IPC wired in C4.C.
 * UI consumes these types in C4.D.
 *
 * Three FS-side checks decide the aggregate status:
 *   - 'symlink': the stable launcher path resolves to an existing target
 *   - 'config':  claude_desktop_config.json is present and parseable
 *   - 'wraps':   every wrap in the config points to an existing binary
 *
 * Aggregate is ternary (healthy / degraded / unhealthy) but C4.1 only
 * uses healthy and unhealthy. 'degraded' is reserved for future checks
 * (recent JSONL activity, live xcg-proxy processes) documented as
 * post-MVP cabos in the C4.0 ficha.
 */

/** Aggregate health status surfaced to the UI as a colored pulse. */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/** Stable identifier for each individual check. */
export type HealthCheckId = 'symlink' | 'config' | 'wraps'

/** A single broken wrap surfaced when the 'wraps' check fails. */
export type BrokenWrapDetail = {
  /** Wrap name as it appears under mcpServers in claude_desktop_config.json. */
  name: string
  /** The command path the wrap currently points to. */
  command: string
}

/**
 * Result of running one health check.
 * Discriminated by 'status' so the UI can narrow safely.
 */
export type HealthCheckResult =
  | { check: HealthCheckId; status: 'ok' }
  | {
      check: HealthCheckId
      status: 'fail'
      reason: string
      /** Only populated for check === 'wraps'. */
      details?: BrokenWrapDetail[]
    }
  | { check: HealthCheckId; status: 'skip'; reason: string }

/**
 * Full result returned by the system:health IPC channel.
 * Aggregate plus the individual checks that produced it.
 */
export type HealthResult = {
  status: HealthStatus
  checks: HealthCheckResult[]
  /** ISO timestamp of when the check completed. */
  checkedAt: string
}

/** Outcome of the system:repair-wraps IPC channel. */
export type RepairResult =
  | {
      ok: true
      /** Names of the wraps that were rewritten to point at the stable path. */
      repairedWraps: string[]
      /** Whether the stable symlink was touched and how. */
      symlinkAction: 'created' | 'recreated' | 'unchanged'
      /** Health re-checked after the repair so the UI can update in one IPC. */
      newHealth: HealthResult
    }
  | {
      ok: false
      /** Human-readable error message for surfacing in the UI. */
      error: string
    }
