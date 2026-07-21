import type { KeyboardEvent } from 'react';

import type { DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';
import { enrichmentToolLabel, formatTimestamp } from './detections-format.js';

import styles from './ClaudeCodeRow.module.css';

// Row for the Claude Code view (F2.4): [severity badge] · Tool · Context ·
// When. Own component instead of a parameterized DetectionRow: the column
// set/order differs and the CC source mini-pill is redundant here (every row
// is claude-code). Atoms (Badge, formatTimestamp, enrichmentToolLabel) are
// shared — only the layout is this view's own.
//
// Context = the most informative field available on the slim row without new
// extraction logic: project (basename(cwd), forward-only from F2.4) when
// present, else the mcp name (the real server for MCP tools consumed via
// hooks; 'claude-code' for native tools).

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

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <Badge severity={row.severity} />
      {row.type === 'mcp.request' ? (
        <span className={styles['tool']}>{row.toolName ?? row.method}</span>
      ) : (
        // Enrichment rows: same per-producer label contract as DetectionRow.
        <span className={styles['toolSoft']}>{enrichmentToolLabel(row.category)}</span>
      )}
      <span className={styles['context']}>{row.project ?? row.mcp}</span>
      <span className={styles['when']}>{formatTimestamp(row.ts)}</span>
    </div>
  );
}
