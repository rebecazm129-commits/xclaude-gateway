import type { KeyboardEvent } from 'react';

import { displayToolName, rawToolName, sourceLabel } from '../../shared/tool-names.js';
import { sourceName } from '../../shared/types.js';
import type { DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';
import {
  ELICITATION_TOOL_LABEL,
  PAIRED_SOURCE_LABELS,
  categoryLabel,
  displaySeverity,
  enrichmentToolLabel,
  formatTimestamp,
  isElicitationRow,
} from './detections-format.js';

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

  // The raw name Claude Code uses (mcp__notion__notion-fetch), on hover, only
  // where the cell shows a cleaned-up one.
  const raw = rawToolName(row);
  const toolTitle = raw !== undefined && raw !== displayToolName(row) ? raw : undefined;

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
      <Badge severity={displaySeverity(row)} />
      <span className={styles['category']}>
        {categoryLabel(row.category, row.method)}
      </span>
      <span className={styles['mcp']}>
        {/* Plain text, the Source chip's own label: "Claude Code", "Notion".
            No pill — the server of a Claude Code MCP call is in TOOL. */}
        {sourceLabel(sourceName(row.source, row.mcp))}
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
        <span className={styles['method']} title={toolTitle}>
          {isElicitationRow(row) ? ELICITATION_TOOL_LABEL : (displayToolName(row) ?? row.method)}
        </span>
      ) : row.toolName !== undefined ? (
        // Orden DELIBERADO (contrato: real tool > real method > synthetic):
        // desde 4c7f859 los enrichments casados heredan el toolName real de
        // su request. El manifest-change nunca hereda toolName — tools/list
        // no lo tiene — así que su rama sigue efectiva.
        <span className={styles['method']} title={toolTitle}>{displayToolName(row)}</span>
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
