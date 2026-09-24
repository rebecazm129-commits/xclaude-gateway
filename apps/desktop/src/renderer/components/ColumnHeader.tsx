// The column definition for an audit list view: labels and widths, declared
// once, used by the header AND by the rows.
//
// WHY. The grid lived in four places — Detections.module.css and
// DetectionRow.module.css, ClaudeCode.module.css and ClaudeCodeRow.module.css
// — with the same track list copied into each pair. ClaudeCodeRow.module.css
// carried the instruction out loud: "Keep the grid in sync with
// ClaudeCode.module.css's .columnHeader". An instruction to keep two files in
// sync by hand is a defect waiting for whoever forgets, and every new column
// doubled the work.
//
// HOW. The track list becomes a CSS custom property set on the container that
// holds both the header and the list, and the rows read it through normal
// inheritance. One declaration per view, in TypeScript, next to the labels it
// belongs with — a column cannot have a width the header disagrees about,
// because there is only one place to write it.

import type { CSSProperties, ReactElement } from 'react';

import styles from './ColumnHeader.module.css';

export interface Column {
  /** Stable key — also the React key. */
  key: string;
  /** Shown uppercase by the stylesheet; written here in Title Case so the
   *  source reads like the product does. */
  label: string;
  /** One CSS grid track: '130px', '1fr'. */
  width: string;
}

/**
 * Put this on the element that contains the header AND the list viewport.
 * Rows inherit the property from it, which is what removes the duplicate.
 */
export function columnsStyle(columns: readonly Column[]): CSSProperties {
  return { '--xcg-columns': columns.map((c) => c.width).join(' ') } as CSSProperties;
}

export function ColumnHeader({ columns }: { columns: readonly Column[] }): ReactElement {
  return (
    <div className={styles['columnHeader']}>
      {columns.map((c) => (
        <span key={c.key} className={styles['columnHeaderCell']}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

// --- the views' column sets -------------------------------------------------

export const DETECTION_COLUMNS: readonly Column[] = [
  { key: 'time', label: 'Time', width: '130px' },
  { key: 'severity', label: 'Severity', width: '90px' },
  { key: 'category', label: 'Category', width: '160px' },
  { key: 'mcp', label: 'MCP', width: '180px' },
  { key: 'tool', label: 'Tool', width: '1fr' },
];

export const CLAUDE_CODE_COLUMNS: readonly Column[] = [
  { key: 'time', label: 'Time', width: '130px' },
  { key: 'severity', label: 'Severity', width: '90px' },
  { key: 'tool', label: 'Tool', width: '180px' },
  { key: 'details', label: 'Details', width: '1fr' },
];
