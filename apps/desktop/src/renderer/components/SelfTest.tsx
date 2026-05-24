import { useState, type ReactElement } from 'react';

import type { SelfTestReport } from '@xcg/shared';

import styles from './SelfTest.module.css';

type BannerTone = 'success' | 'error';

// Map the run outcome to a user-facing banner. Exhaustive over the 5 outcome
// kinds; the never-guard turns a future 6th kind into a compile error, and the
// throw is fail-fast at runtime (returning never would yield undefined and
// break the render silently).
function bannerFor(report: SelfTestReport): { tone: BannerTone; text: string } {
  const outcome = report.outcome;
  switch (outcome.kind) {
    case 'complete_pass':
      return { tone: 'success', text: `All ${report.entries.length} checks passed. Detection is working.` };
    case 'detection_mismatch':
      return { tone: 'error', text: 'Some checks returned unexpected results. Detection may be misconfigured.' };
    case 'timeout_partial':
      return { tone: 'error', text: "Some checks didn't complete in time. Try again." };
    case 'timeout_no_data':
      return { tone: 'error', text: 'No checks completed. The gateway may not be intercepting traffic.' };
    case 'spawn_failed':
      return { tone: 'error', text: `Couldn't run the self-test: ${outcome.reason}` };
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled outcome: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function SelfTestResult({ report }: { report: SelfTestReport }): ReactElement {
  const banner = bannerFor(report);
  return (
    <>
      <div className={styles[`banner_${banner.tone}`]} role="status">
        {banner.text}
      </div>
      {report.entries.length > 0 ? (
        <ul className={styles['entries']}>
          {report.entries.map((entry) => (
            <li key={entry.example.categoryKey} className={styles['entry']}>
              <span className={entry.pass ? styles['statusPass'] : styles['statusFail']}>
                {entry.pass ? '✓' : '✗'}
              </span>
              <span className={styles['entryLabel']}>{entry.example.label}</span>
              <span className={styles['entryDetail']}>
                {entry.actual === null
                  ? 'not observed'
                  : entry.pass
                    ? `${entry.actual.category} / ${entry.actual.severity}`
                    : `got ${entry.actual.category} / ${entry.actual.severity}, expected ${entry.example.categoryKey} / ${entry.example.expectedSeverity}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * "Verify detection" panel for the Setup tab. Self-contained: invokes
 * window.xcg.runSelfTest() internally, which spawns the real xcg-proxy wrapper
 * around server-everything, sends one echo tool-call per registry example, and
 * reads detections back. Always visible in the status.ok render of Setup; the
 * self-test is independent of the user's own wraps (it spawns its own wrapper).
 *
 * The catch covers an IPC rejection if the orchestrator's reader/send throws
 * post-spawn — the only path outside the SelfTestReport outcome union.
 */
export function SelfTest(): ReactElement {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun(): Promise<void> {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const result = await window.xcg.runSelfTest();
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles['container']}>
      <div className={styles['header']}>
        <div className={styles['heading']}>
          <p className={styles['title']}>Verify detection</p>
          <p className={styles['subtitle']}>
            Run a safe end-to-end check that the gateway intercepts and flags risky tool calls.
          </p>
        </div>
        <button
          type="button"
          className={styles['runButton']}
          onClick={() => void handleRun()}
          disabled={running}
        >
          {running ? 'Verifying…' : 'Verify detection'}
        </button>
      </div>

      {error !== null ? (
        <div className={styles['banner_error']}>Self-test failed: {error}</div>
      ) : null}

      {report !== null ? <SelfTestResult report={report} /> : null}
    </div>
  );
}
