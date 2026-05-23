import { useState, type ReactElement } from 'react';

import type { HealthResult, RepairResult } from '@xcg/shared';

import styles from './HealthWarning.module.css';

export interface HealthWarningProps {
  readonly health: HealthResult | null;
  readonly onRepaired: (result: RepairResult) => void;
}

/**
 * Actionable panel rendered above the tab content when health.status is
 * 'unhealthy' AND the failure is repairable (the 'wraps' check fails with
 * broken-wrap details).
 *
 * Self-contained: invokes window.xcg.repairWraps() internally, shows
 * progress, and notifies the parent via onRepaired so App can refresh both
 * health AND configStatus (per C4-D-12).
 *
 * Returns null when there is nothing to warn about. Per C4.0 (Notion ficha
 * 369242b46fa7817184cec3d0a0ce4647), C4.1 emits only 'healthy' and
 * 'unhealthy'. The unhealthy panel covers the broken-wraps case; other
 * unhealthy causes (missing symlink, missing config) show the pulse red +
 * tooltip but no actionable panel (no automatic repair path in MVP).
 */
export function HealthWarning({ health, onRepaired }: HealthWarningProps): ReactElement | null {
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (health === null) return null;
  if (health.status !== 'unhealthy') return null;

  const wrapsCheck = health.checks.find((c) => c.check === 'wraps');
  if (!wrapsCheck || wrapsCheck.status !== 'fail') return null;
  if (!wrapsCheck.details || wrapsCheck.details.length === 0) return null;

  const brokenNames = wrapsCheck.details.map((d) => d.name);

  async function handleRepair(): Promise<void> {
    setRepairing(true);
    setError(null);
    try {
      const result = await window.xcg.repairWraps();
      if (!result.ok) {
        setError(result.error);
      } else {
        onRepaired(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className={styles['warning']} role="alert">
      <p className={styles['title']}>Your config needs attention</p>
      <p className={styles['body']}>
        {brokenNames.length === 1
          ? '1 MCP server in your Claude Desktop config points to a path that no longer exists on disk:'
          : `${brokenNames.length} MCP servers in your Claude Desktop config point to paths that no longer exist on disk:`}
      </p>
      <ul className={styles['list']}>
        {brokenNames.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className={styles['body']}>
        Claude Desktop will fail to start these wrapped MCPs. Click Repair to update them to use the stable launcher path.
      </p>
      <div className={styles['actions']}>
        <button
          type="button"
          className={styles['repairButton']}
          onClick={() => void handleRepair()}
          disabled={repairing}
        >
          {repairing ? 'Repairing…' : 'Repair config'}
        </button>
        {error !== null ? (
          <span className={`${styles['feedback']} ${styles['feedbackError']}`}>
            Repair failed: {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
