import type { Severity } from '../../shared/types.js';

import styles from './SeverityBreakdown.module.css';

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const SEVERITY_LABELS: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

interface Props {
  counts: Record<Severity, number>;
  total: number;
  selectedSeverities: readonly Severity[];
  totalSeverityOptionsCount: number;
  onSelectTotal: () => void;
  onSelectSeverity: (severity: Severity) => void;
}

export function SeverityBreakdown({
  counts,
  total,
  selectedSeverities,
  totalSeverityOptionsCount,
  onSelectTotal,
  onSelectSeverity,
}: Props): JSX.Element {
  const allSelected = selectedSeverities.length === totalSeverityOptionsCount;
  const selectedSet = new Set(selectedSeverities);

  return (
    <div className={styles['banda']}>
      <div className={styles['grid']}>
        <button
          type="button"
          className={`${styles['card']} ${styles['card_total']} ${
            allSelected ? styles['cardActive'] : styles['cardInactive']
          }`}
          onClick={onSelectTotal}
        >
          <div className={styles['number']}>{total}</div>
          <div className={styles['label']}>Total</div>
        </button>
        {SEVERITY_ORDER.map((severity) => {
          const isActive = !allSelected && selectedSet.has(severity) && selectedSeverities.length === 1;
          const isInactive = !allSelected && !selectedSet.has(severity);
          return (
            <button
              key={severity}
              type="button"
              className={`${styles['card']} ${styles[`card_${severity}`]} ${
                isActive ? styles['cardActive'] : ''
              } ${isInactive ? styles['cardInactive'] : ''}`}
              onClick={() => onSelectSeverity(severity)}
            >
              <div className={styles['number']}>{counts[severity]}</div>
              <div className={styles['label']}>{SEVERITY_LABELS[severity]}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
