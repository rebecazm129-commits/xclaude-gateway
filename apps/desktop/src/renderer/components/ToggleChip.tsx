// A one-state filter chip: on or off, no menu.
//
// Extracted from Claude Code's "Flagged only", which was loose JSX plus a
// hand-built class string. It is a chip in the same row as the FilterDropdown
// chips and has to look like them, so the styling stays where theirs is —
// ClaudeCode.module.css — and this component only owns the behaviour and the
// accessibility. A second copy of that CSS is exactly what this is preventing.
//
// Deliberately NOT a variant of FilterDropdown: that one owns an options list,
// a popup, outside-click handling and a ref for it. A boolean has none of
// those, and folding it in would give every caller a menu it never opens.

import type { ReactElement } from 'react';

import { Tooltip } from './Tooltip.js';

import styles from './ClaudeCode.module.css';

interface ToggleChipProps {
  readonly label: string;
  /** The hover explanation. Required: a chip whose effect is not obvious from
   *  two words is a chip the user will be afraid to press. */
  readonly tooltip: string;
  readonly active: boolean;
  readonly onChange: (next: boolean) => void;
}

export function ToggleChip({ label, tooltip, active, onChange }: ToggleChipProps): ReactElement {
  return (
    <Tooltip text={tooltip}>
      <button
        type="button"
        className={active ? `${styles['flaggedChip']} ${styles['flaggedChipActive']}` : styles['flaggedChip']}
        aria-pressed={active}
        onClick={() => onChange(!active)}
      >
        {label}
      </button>
    </Tooltip>
  );
}
