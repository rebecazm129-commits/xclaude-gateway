import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';

import { usePolledDetections } from '../hooks/usePolledDetections.js';
import type { EnrichableEvent, Severity, Category } from '../../shared/types.js';

import { DetailDrawer } from './DetailDrawer.js';
import { DetectionRow } from './DetectionRow.js';
import { FilterDropdown } from './FilterDropdown.js';
import { NewEventsPill } from './NewEventsPill.js';
import { SeverityBreakdown } from './SeverityBreakdown.js';

import styles from './Detections.module.css';

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
const HEADER_AND_FILTERS_HEIGHT = 248;

export function Detections(): JSX.Element {
  const detections = usePolledDetections();
  const [selectedSeverities, setSelectedSeverities] =
    useState<readonly Severity[]>(SEVERITY_OPTIONS);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly Category[]>(CATEGORY_OPTIONS);
  const [selectedEvent, setSelectedEvent] = useState<EnrichableEvent | null>(null);
  const [openDropdown, setOpenDropdown] = useState<'severity' | 'category' | null>(null);
  const severityRef = useRef<HTMLDivElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(
    window.innerHeight - HEADER_AND_FILTERS_HEIGHT,
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<FixedSizeList>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastSeenTopId, setLastSeenTopId] = useState<string | null>(null);

  useEffect(() => {
    function onResize(): void {
      setListHeight(window.innerHeight - HEADER_AND_FILTERS_HEIGHT);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (openDropdown === null) return;
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      const target = e.target as Node;
      const insideSeverity = severityRef.current?.contains(target) ?? false;
      const insideCategory = categoryRef.current?.contains(target) ?? false;
      if (!insideSeverity && !insideCategory) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [openDropdown]);

  const categoryFiltered = useMemo(() => {
    const catSet = new Set(selectedCategories);
    return detections.filter((d) => catSet.has(d.detection.category));
  }, [detections, selectedCategories]);

  const counts = useMemo(() => {
    const result: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const d of categoryFiltered) {
      result[d.detection.severity] += 1;
    }
    return result;
  }, [categoryFiltered]);

  const filtered = useMemo(() => {
    const sevSet = new Set(selectedSeverities);
    return categoryFiltered.filter((d) => sevSet.has(d.detection.severity));
  }, [categoryFiltered, selectedSeverities]);

  useEffect(() => {
    if (scrollOffset === 0 && filtered.length > 0) {
      const topId = filtered[0]?.id ?? null;
      if (topId !== null && topId !== lastSeenTopId) {
        setLastSeenTopId(topId);
      }
    }
  }, [scrollOffset, filtered, lastSeenTopId]);

  useEffect(() => {
    setLastSeenTopId(filtered[0]?.id ?? null);
    setScrollOffset(0);
  }, [selectedSeverities, selectedCategories]);

  const newCount = useMemo(() => {
    if (lastSeenTopId === null) return 0;
    if (scrollOffset === 0) return 0;
    const idx = filtered.findIndex((d) => d.id === lastSeenTopId);
    if (idx === -1) return 0;
    return idx;
  }, [filtered, lastSeenTopId, scrollOffset]);

  function handleRowClick(event: EnrichableEvent): void {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedEvent(event);
  }

  function handleDrawerClose(): void {
    setSelectedEvent(null);
    const trigger = triggerRef.current;
    if (trigger !== null && document.body.contains(trigger)) {
      trigger.focus();
    }
    triggerRef.current = null;
  }

  function handleSelectTotal(): void {
    setSelectedSeverities(SEVERITY_OPTIONS);
  }

  function handleSelectSeverity(severity: Severity): void {
    setSelectedSeverities((prev) => {
      if (prev.length === 1 && prev[0] === severity) {
        return SEVERITY_OPTIONS;
      }
      return [severity];
    });
  }

  function handlePillClick(): void {
    listRef.current?.scrollTo(0);
    setLastSeenTopId(filtered[0]?.id ?? null);
  }

  return (
    <>
      <SeverityBreakdown
        counts={counts}
        total={categoryFiltered.length}
        selectedSeverities={selectedSeverities}
        totalSeverityOptionsCount={SEVERITY_OPTIONS.length}
        onSelectTotal={handleSelectTotal}
        onSelectSeverity={handleSelectSeverity}
      />
      <div className={styles['filters']}>
        <FilterDropdown
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={selectedSeverities}
          onChange={setSelectedSeverities}
          isOpen={openDropdown === 'severity'}
          onToggle={() => setOpenDropdown((prev) => (prev === 'severity' ? null : 'severity'))}
          dropdownRef={severityRef}
        />
        <FilterDropdown
          label="Category"
          options={CATEGORY_OPTIONS}
          selected={selectedCategories}
          onChange={setSelectedCategories}
          isOpen={openDropdown === 'category'}
          onToggle={() => setOpenDropdown((prev) => (prev === 'category' ? null : 'category'))}
          dropdownRef={categoryRef}
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles['empty']}>
          No detections yet. Wrap an MCP server with xcg-proxy to start auditing.
        </div>
      ) : (
        <div className={styles['listContainer']}>
          <FixedSizeList
            ref={listRef}
            height={listHeight}
            width="100%"
            itemSize={ROW_HEIGHT}
            itemCount={filtered.length}
            itemKey={(index) => filtered[index]?.id ?? index}
            onScroll={({ scrollOffset: offset }) => setScrollOffset(offset)}
          >
            {({ index, style }) => {
              const item = filtered[index];
              if (item === undefined) return null;
              return (
                <div style={style}>
                  <DetectionRow
                    event={item}
                    selected={selectedEvent?.id === item.id}
                    onClick={() => handleRowClick(item)}
                  />
                </div>
              );
            }}
          </FixedSizeList>
          {newCount > 0 && (
            <NewEventsPill count={newCount} onClick={handlePillClick} />
          )}
        </div>
      )}
      {selectedEvent !== null && (
        <DetailDrawer event={selectedEvent} onClose={handleDrawerClose} />
      )}
    </>
  );
}
