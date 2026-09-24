import { useEffect, useState } from 'react';

import type { DetectionFilter } from '../../shared/types.js';

import styles from './AuditFooter.module.css';

// Shared footer for the audit list views (Detections, ClaudeCode): "Open
// audit folder" + "Export N events". Extracted verbatim from Detections
// (F2.4 commit 4) so the Claude Code view reuses it. Export ships the view's
// ACTIVE filter — the exporter reuses matchesFilter server-side, so export
// and view filter identically by construction (fixed sources included).

// First clause of an error message (drop the path/detail after the first
// comma or newline) so the footer status stays on one line.
function briefError(message: string): string {
  return message.split(/[\n,]/)[0] ?? message;
}

interface AuditFooterProps {
  readonly filter: DetectionFilter;
  /** Whole event set size — gates "Open audit folder". */
  readonly total: number;
  /** Filtered count — the export target size. */
  readonly totalMatching: number;
  /** What the rows ARE, singular. The footer says "Export 12 changes" on a
   *  view of connector changes and "Export 12 events" everywhere else; calling
   *  a change an event would be the footer disagreeing with the column above
   *  it. Defaults to the existing wording, so the two views that predate this
   *  read exactly as they did. */
  readonly noun?: string;
  /** Overrides what "Export" does. Changes exports a versioned document of
   *  connector changes, not a slice of the tool-call trail, so it supplies its
   *  own; the two views that predate it pass nothing and keep exportAudit. */
  readonly onExport?: () => Promise<{ ok: true; count: number } | { ok: false; error: string } | null>;
}

export function AuditFooter({ filter, total, totalMatching, noun = 'event', onExport }: AuditFooterProps): JSX.Element {
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ count: number } | { error: string } | null>(null);

  // A new filter means a new export target: clear the last result so the
  // button reverts to "Export {N} events" for the new count (behavior moved
  // from Detections' filter-change effect).
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setExportResult(null);
  }, [filterKey]);

  function handleOpenAuditFolder(): void {
    void window.xcg.openAuditFolder();
  }

  // Export "what you see": the active DetectionFilter, to a user-chosen file.
  async function handleExport(): Promise<void> {
    setExporting(true);
    setExportResult(null);
    try {
      const result = onExport !== undefined ? await onExport() : await window.xcg.exportAudit(filter, 'jsonl');
      if (result === null) {
        // Cancelled: leave the status cleared.
      } else if (result.ok) {
        setExportResult({ count: result.count });
      } else if ('error' in result) {
        setExportResult({ error: briefError(result.error) });
      }
      // canceled → leave the status cleared
    } catch (err) {
      console.error('audit:export failed:', err);
      setExportResult({ error: briefError(err instanceof Error ? err.message : 'Unexpected error') });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className={styles['footer']}>
      <button
        type="button"
        className={styles['footerLink']}
        onClick={handleOpenAuditFolder}
        disabled={total === 0}
      >
        Open audit folder
      </button>
      <div className={styles['exportGroup']}>
        {exportResult !== null && 'count' in exportResult && (
          <span className={styles['exportStatus']}>
            Exported {exportResult.count} {noun}{exportResult.count === 1 ? '' : 's'}
          </span>
        )}
        {exportResult !== null && 'error' in exportResult && (
          <span className={styles['exportError']}>
            Export failed — {exportResult.error}
          </span>
        )}
        <button
          type="button"
          className={styles['exportButton']}
          onClick={() => void handleExport()}
          disabled={totalMatching === 0 || exporting}
        >
          {exporting
            ? 'Exporting…'
            : exportResult !== null
              ? 'Export…'
              : `Export ${totalMatching} ${noun}${totalMatching === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
