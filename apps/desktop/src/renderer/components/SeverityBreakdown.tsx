// The five counter cards above an audit list.
//
// WHY THE CARDS ARE A PROP NOW. Detections and Claude Code both count the same
// axis — Total plus four severities — so the axis was hard-coded. Changes
// counts a different one: 197 of 217 real connector changes carry no severity
// at all, and `critical` is produced by no rule, so a CRITICAL card would sit
// at zero forever while the question the tab exists to answer ("what still
// needs a look?") had nowhere to appear.
//
// The order is fixed by the caller, not here, because these five cards are a
// row the eye learns: TOTAL first and the axis rising to the right. Changes
// puts NEEDS REVIEW in the slot CRITICAL held, so the shape stays familiar
// even though the last card asks a different question.
//
// A card knows how to be "the only one selected" or "not selected"; it does
// not know what selecting it means. That stays with the view, which is the
// only place that knows whether a card maps to a severity, a review state, or
// something later.

import type { Severity } from '../../shared/types.js';

import { Tooltip } from './Tooltip.js';

import styles from './SeverityBreakdown.module.css';

export interface BreakdownCard {
  /** Stable key — also the React key and the CSS modifier (card_<key>). */
  key: string;
  label: string;
  count: number;
  /** Rendered as the single selected card. */
  active: boolean;
  /** Dimmed: some other card is the selection. */
  inactive: boolean;
  onSelect: () => void;
  /** What the number counts, on hover. Optional: TOTAL and the four
   *  severities explain themselves, a card counting something else may not. */
  tooltip?: string;
}

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const SEVERITY_LABELS: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * The card row Detections and Claude Code use: Total, then the four
 * severities. Kept as a helper so neither view had to restate an axis they
 * already agreed on.
 */
export function severityCards(args: {
  counts: Record<Severity, number>;
  total: number;
  selectedSeverities: readonly Severity[];
  totalSeverityOptionsCount: number;
  onSelectTotal: () => void;
  onSelectSeverity: (severity: Severity) => void;
}): BreakdownCard[] {
  const allSelected = args.selectedSeverities.length === args.totalSeverityOptionsCount;
  const selectedSet = new Set(args.selectedSeverities);
  return [
    {
      key: 'total',
      label: 'Total',
      count: args.total,
      active: allSelected,
      inactive: !allSelected,
      onSelect: args.onSelectTotal,
    },
    ...SEVERITY_ORDER.map((severity) => ({
      key: severity,
      label: SEVERITY_LABELS[severity],
      count: args.counts[severity],
      active: !allSelected && selectedSet.has(severity) && args.selectedSeverities.length === 1,
      inactive: !allSelected && !selectedSet.has(severity),
      onSelect: () => args.onSelectSeverity(severity),
    })),
  ];
}

export function SeverityBreakdown({ cards }: { cards: readonly BreakdownCard[] }): JSX.Element {
  return (
    <div className={styles['banda']}>
      {/* As many columns as cards: MCP changes has four. Five is the value the
          stylesheet used to fix, so the other two tabs lay out as before. */}
      <div className={styles['grid']} style={{ gridTemplateColumns: `repeat(${cards.length}, 1fr)` }}>
        {cards.map((card) => {
          const button = (
            <button
              key={card.key}
              type="button"
              className={`${styles['card']} ${styles[`card_${card.key}`] ?? ''} ${
                card.active ? styles['cardActive'] : ''
              } ${card.inactive ? styles['cardInactive'] : ''} ${
                card.tooltip !== undefined ? styles['cardWrapped'] : ''
              }`}
              onClick={card.onSelect}
              aria-pressed={card.active}
            >
              <div className={styles['number']}>{card.count}</div>
              <div className={styles['label']}>{card.label}</div>
            </button>
          );
          return card.tooltip !== undefined ? (
            <Tooltip key={card.key} text={card.tooltip}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
    </div>
  );
}
