import { useEffect, useMemo, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { DetectionRow } from './components/DetectionRow.js';
import { FilterDropdown } from './components/FilterDropdown.js';
import { usePolledDetections } from './hooks/usePolledDetections.js';
import type { Severity, Category } from '../shared/types.js';

import styles from './App.module.css';

const SEVERITY_OPTIONS: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const CATEGORY_OPTIONS: readonly Category[] = [
  'credential_detected',
  'prompt_injection',
  'email_send_warning',
  'data_export_warning',
  'tool_call_allowed',
  'pii_detected',
];

const ROW_HEIGHT = 32;
const HEADER_AND_FILTERS_HEIGHT = 112;

export function App(): JSX.Element {
  const detections = usePolledDetections();
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly Category[]>(CATEGORY_OPTIONS);
  const [listHeight, setListHeight] = useState(
    window.innerHeight - HEADER_AND_FILTERS_HEIGHT,
  );

  useEffect(() => {
    function onResize(): void {
      setListHeight(window.innerHeight - HEADER_AND_FILTERS_HEIGHT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const filtered = useMemo(() => {
    const sevSet = new Set(selectedSeverities);
    const catSet = new Set(selectedCategories);
    return detections.filter(
      (d) => sevSet.has(d.detection.severity) && catSet.has(d.detection.category),
    );
  }, [detections, selectedSeverities, selectedCategories]);

  return (
    <div className={styles['app']}>
      <header className={styles['header']}>
        <span className={styles['titleGroup']}>
          <span className={styles['pulse']} aria-hidden="true" />
          <h1 className={styles['title']}>xCLAUDE Gateway</h1>
        </span>
        <span className={styles['counter']}>Detections: {filtered.length}</span>
      </header>
      <div className={styles['filters']}>
        <FilterDropdown
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={selectedSeverities}
          onChange={setSelectedSeverities}
        />
        <FilterDropdown
          label="Category"
          options={CATEGORY_OPTIONS}
          selected={selectedCategories}
          onChange={setSelectedCategories}
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles['empty']}>
          No detections yet. Wrap an MCP server with xcg-proxy to start auditing.
        </div>
      ) : (
        <FixedSizeList
          height={listHeight}
          width="100%"
          itemSize={ROW_HEIGHT}
          itemCount={filtered.length}
          itemKey={(index) => filtered[index]?.id ?? index}
        >
          {({ index, style }) => {
            const item = filtered[index];
            if (item === undefined) return null;
            return (
              <div style={style}>
                <DetectionRow event={item} />
              </div>
            );
          }}
        </FixedSizeList>
      )}
    </div>
  );
}
