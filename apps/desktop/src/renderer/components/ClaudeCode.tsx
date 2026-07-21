import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { useDetectionPage } from '../hooks/useDetectionPage.js';
import type { DetectionFilter, DetectionRowSlim } from '../../shared/types.js';

import { CATEGORY_OPTIONS, SEVERITY_OPTIONS } from './Detections.js';
import { ClaudeCodeRow } from './ClaudeCodeRow.js';
import { DetailDrawer } from './DetailDrawer.js';
import { TimeFilter, type TimeRange } from './TimeFilter.js';

import styles from './ClaudeCode.module.css';

// Claude Code view (F2.4, commit 2): the claude-code slice of the audit
// trail as its own tab — sibling of Detections, not a full clone. This v1 is
// the minimal skeleton: fixed source, virtualized list (own row layout),
// shared DetailDrawer and TimeFilter. The CC-specific filters
// (tool/ccSession/project), session separators and the flagged counter land
// in commit 3.

const ROW_HEIGHT = 40;
// Chrome above/around the list: titlebar (42, mirrors --kraft-titlebar-height
// in index.css) + header (84) + tabs (40) + time-filter bar (56, .filters) +
// column header (~33). No footer in this view (unlike Detections).
const CHROME_HEIGHT = 255;
// Rows from the end at which we prefetch the next page (same threshold as
// Detections' infinite scroll).
const LOAD_MORE_THRESHOLD = 20;

export function ClaudeCode(): JSX.Element {
  const [selectedRow, setSelectedRow] = useState<DetectionRowSlim | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  const [listHeight, setListHeight] = useState(
    window.innerHeight - CHROME_HEIGHT,
  );
  const triggerRef = useRef<HTMLElement | null>(null);

  // Source is FIXED: this view IS the claude-code slice. No Source chip is
  // rendered, so the user cannot widen or drop it. Severities/categories stay
  // at "everything" in this commit (the CC filters are commit 3); time is the
  // only user-controlled axis.
  const filter: DetectionFilter = useMemo(
    () => ({
      mcp: null,
      timeRange: selectedTimeRange,
      categories: [...CATEGORY_OPTIONS],
      severities: [...SEVERITY_OPTIONS],
      sources: ['claude-code'],
    }),
    [selectedTimeRange],
  );

  const page = useDetectionPage(filter);
  const { rows } = page;

  useEffect(() => {
    function onResize(): void {
      setListHeight(window.innerHeight - CHROME_HEIGHT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleRowClick(row: DetectionRowSlim): void {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedRow(row);
  }

  function handleDrawerClose(): void {
    setSelectedRow(null);
    const trigger = triggerRef.current;
    if (trigger !== null && document.body.contains(trigger)) {
      trigger.focus();
    }
    triggerRef.current = null;
  }

  return (
    <>
      <div className={styles['filters']}>
        <div className={styles['timeFilterSpacer']}>
          <TimeFilter value={selectedTimeRange} onChange={setSelectedTimeRange} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div className={styles['empty']}>
          No Claude Code activity yet. Install the Claude Code hook in Sources
          to start auditing.
        </div>
      ) : (
        <div className={styles['listContainer']}>
          <div className={styles['columnHeader']}>
            <span className={styles['columnHeaderCell']}>Severity</span>
            <span className={styles['columnHeaderCell']}>Tool</span>
            <span className={styles['columnHeaderCell']}>Context</span>
            <span className={styles['columnHeaderCell']}>When</span>
          </div>
          <FixedSizeList
            height={listHeight}
            width="100%"
            itemSize={ROW_HEIGHT}
            itemCount={rows.length}
            itemKey={(index) => rows[index]?.id ?? index}
            onItemsRendered={({ visibleStopIndex }) => {
              if (page.hasMore && visibleStopIndex >= rows.length - LOAD_MORE_THRESHOLD) {
                page.loadMore();
              }
            }}
          >
            {({ index, style }) => {
              const item = rows[index];
              if (item === undefined) return null;
              return (
                <div style={style}>
                  <ClaudeCodeRow
                    row={item}
                    selected={selectedRow?.id === item.id}
                    onClick={() => handleRowClick(item)}
                  />
                </div>
              );
            }}
          </FixedSizeList>
        </div>
      )}
      {selectedRow !== null && (
        <DetailDrawer row={selectedRow} onClose={handleDrawerClose} />
      )}
    </>
  );
}
