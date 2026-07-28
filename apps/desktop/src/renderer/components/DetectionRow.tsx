import type { KeyboardEvent } from 'react';

import type { DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';
import { CATEGORY_LABELS, PAIRED_SOURCE_LABELS, enrichmentToolLabel, formatTimestamp } from './detections-format.js';

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
        {row.pairedSource !== undefined ? (
          // Paired-badge (frente 3): the same tool-use exists in the OTHER
          // source's record. Independent of the CC badge — a paired wrapper
          // row carries this pill without carrying CC.
          <span
            className={styles['pairedBadge']}
            data-testid="paired-badge"
            title={PAIRED_SOURCE_LABELS[row.pairedSource]}
          >
            ⧉
          </span>
        ) : null}
      </span>
      {row.type === 'mcp.request' ? (
        <span className={styles['method']}>
          {row.toolName ?? row.method}
        </span>
      ) : row.toolName !== undefined ? (
        // Orden DELIBERADO (contrato: real tool > real method > synthetic):
        // desde 4c7f859 los enrichments casados heredan el toolName real de
        // su request. El manifest-change nunca hereda toolName — tools/list
        // no lo tiene — así que su rama sigue efectiva.
        <span className={styles['method']}>{row.toolName}</span>
      ) : row.category === 'tool_manifest_changed' ? (
        // Manifest-change enrichment: it rides on the tools/list response, not
        // the async NER path, so label the source method, not [NER].
        <span className={styles['method']}>tools/list</span>
      ) : (
        // Huérfanas reales (sin request en el trail): honest per-producer
        // label ([NER] / [content]), bracket style. See enrichmentToolLabel
        // for the column contract.
        <span className={styles['ner']}>{enrichmentToolLabel(row.category)}</span>
      )}
    </div>
  );
}
