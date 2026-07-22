import type { KeyboardEvent } from 'react';

import type { DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, enrichmentToolLabel, formatTimestamp } from './detections-format.js';
import { Tooltip } from './Tooltip.js';

import styles from './ClaudeCodeRow.module.css';

// Row for the Claude Code view (F2.4 commit 4): Time · [severity badge] ·
// Tool · Details — same order/naming as Detections' row. Own component
// instead of a parameterized DetectionRow: the column set differs (no
// Category column, no MCP column, no CC mini-pill) while the atoms (Badge,
// formatTimestamp, CATEGORY_LABELS, enrichmentToolLabel) are shared.
//
// Details cell:
// - requests: argsSummary ?? project ?? mcp. Flagged rows (category !==
//   tool_call_allowed) PREFIX the readable category label — chosen over a
//   tag next to the badge: the 90px badge column has no room for text and a
//   fifth column would break the Detections-parity grid; the 1fr Details
//   cell absorbs it as context for the payload. Baseline rows show nothing.
// - enrichments: the category label IS the Details (an enrichment has no
//   args/project; "[content] · claude-code" said nothing). The Tool cell
//   keeps enrichmentToolLabel — the producer ([NER] vs [content]) is still
//   signal in an all-CC view.

interface ClaudeCodeRowProps {
  row: DetectionRowSlim;
  selected: boolean;
  onClick: () => void;
}

export function ClaudeCodeRow({ row, selected, onClick }: ClaudeCodeRowProps): JSX.Element {
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  const className = selected
    ? `${styles['row']} ${styles['rowSelected']}`
    : styles['row'];

  const flagged = row.category !== 'tool_call_allowed';

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <span className={styles['timestamp']}>{formatTimestamp(row.ts)}</span>
      <Badge severity={row.severity} />
      {row.type === 'mcp.request' ? (
        <span className={styles['tool']}>
          {row.outcome === 'error' && (
            // Discreet error dot (delta final): real outcome data from the
            // request↔response correlation. Wrapped in the house Tooltip
            // (delta de cierre m) so hover explains it; aria-label matches.
            <Tooltip text="This call failed">
              <span
                className={styles['errorDot']}
                role="img"
                aria-label="This call failed"
                data-testid="error-dot"
              />
            </Tooltip>
          )}
          {row.toolName ?? row.method}
        </span>
      ) : (
        <span className={styles['toolSoft']}>{enrichmentToolLabel(row.category)}</span>
      )}
      {row.type === 'mcp.request' ? (
        <span className={styles['context']}>
          {flagged && (
            <span className={styles['categoryTag']}>{CATEGORY_LABELS[row.category]}</span>
          )}
          {row.argsSummary ?? row.project ?? row.mcp}
        </span>
      ) : (
        <span className={styles['context']}>{CATEGORY_LABELS[row.category]}</span>
      )}
    </div>
  );
}
