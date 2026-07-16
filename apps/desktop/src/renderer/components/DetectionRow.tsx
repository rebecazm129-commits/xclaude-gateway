import type { KeyboardEvent } from 'react';

import type { DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, enrichmentToolLabel, formatTimestamp } from './detections-format.js';

import styles from './DetectionRow.module.css';

interface DetectionRowProps {
  row: DetectionRowSlim;
  selected: boolean;
  onClick: () => void;
}

export function DetectionRow({ row, selected, onClick }: DetectionRowProps): JSX.Element {
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
      <span className={styles['timestamp']}>{formatTimestamp(row.ts)}</span>
      <Badge severity={row.severity} />
      <span className={styles['category']}>
        {CATEGORY_LABELS[row.category]}
      </span>
      <span className={styles['mcp']}>
        {row.mcp}
        {row.source === 'claude-code' ? (
          // Mini-pill in the entryKind style (Setup list): suffix badge, not a
          // sixth column — Claude Code rows stay scannable in the MCP cell.
          <span className={styles['sourceBadgeCc']} data-testid="source-badge-cc" title="Claude Code">
            CC
          </span>
        ) : null}
      </span>
      {row.type === 'mcp.request' ? (
        <span className={styles['method']}>
          {row.toolName ?? row.method}
        </span>
      ) : row.category === 'tool_manifest_changed' ? (
        // Manifest-change enrichment: it rides on the tools/list response, not
        // the async NER path, so label the source method, not [NER].
        <span className={styles['method']}>tools/list</span>
      ) : (
        // Other enrichments: honest per-producer label ([NER] / [content]),
        // bracket style. See enrichmentToolLabel for the column contract.
        <span className={styles['ner']}>{enrichmentToolLabel(row.category)}</span>
      )}
    </div>
  );
}
