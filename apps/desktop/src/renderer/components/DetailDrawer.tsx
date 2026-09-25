import { useEffect, useRef, useState } from 'react';

import type { Category, DetectionDetail, DetectionFinding, DetectionRowSlim } from '../../shared/types.js';
import type { ConnectorChangeView } from '../lib/xcgApi.js';
import { ChangeDetail } from './ChangeDetail.js';
import { Badge } from './Badge.js';
import { PAIRED_SOURCE_LABELS, SOURCE_LABELS, categoryLabel } from './detections-format.js';

import styles from './DetailDrawer.module.css';

const MONTH_SHORT: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, '0');
  const month = MONTH_SHORT[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}:${ss}`;
}

/**
 * The drawer takes EITHER a tool-call detection or a connector change.
 *
 * A union rather than a second component: the chrome is the load-bearing part
 * — the panel, the focus handling, Escape, the footer — and two copies of it
 * would drift the moment one of them gets a fix. What differs is the body, and
 * that is the only thing that branches.
 */
export type DetailDrawerProps =
  | { row: DetectionRowSlim; onClose: () => void; change?: never; onReview?: never }
  | {
      change: ConnectorChangeView | null;
      onReview: (change: ConnectorChangeView) => void;
      onClose: () => void;
      row?: never;
    };

// Findings with the same (type, location) are byte-identical — the shape
// carries no raw datum — so repeats only encode multiplicity. Collapse them
// for DISPLAY with a counter; the audit log keeps every entry (the JSONL is
// the product). Grouping never crosses types: the deliberate nl_bsn/pt_nif
// multi-label stays two rows.
interface GroupedFinding {
  type: string;
  location?: string;
  count: number;
}

export function groupFindings(findings: readonly DetectionFinding[]): GroupedFinding[] {
  const groups = new Map<string, GroupedFinding>();
  for (const f of findings) {
    const key = `${f.type}|${f.location ?? ''}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        type: f.type,
        ...(f.location !== undefined ? { location: f.location } : {}),
        count: 1,
      });
    } else {
      existing.count++;
    }
  }
  return [...groups.values()];
}

// The heavy view is fetched lazily by id when the drawer opens. The header
// renders immediately from the slim row; the body shows a loading state, the
// fetched detail, or a clean "no longer available" note if the event's session
// file was purged between the list poll and the click.
type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: DetectionDetail }
  | { kind: 'unavailable' };

function DetectionDetailPanel({ row, onClose }: { row: DetectionRowSlim; onClose: () => void }): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const headingId = `drawer-heading-${row.id}`;
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [state, setState] = useState<DetailState>({ kind: 'loading' });

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void window.xcg
      .detectionDetail(row.id)
      .then((detail) => {
        if (cancelled) return;
        setState(detail === null ? { kind: 'unavailable' } : { kind: 'ready', detail });
      })
      .catch((err) => {
        console.error('detection:detail failed:', err);
        if (!cancelled) setState({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = false;
    const timer = setTimeout(() => {
      active = true;
    }, 0);
    function onMouseDown(e: MouseEvent): void {
      if (!active) return;
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose]);

  const detail = state.kind === 'ready' ? state.detail : null;

  function handleCopyJson(): void {
    void navigator.clipboard.writeText(JSON.stringify(detail ?? row, null, 2));
  }

  const isRequest = detail?.type === 'mcp.request';
  const toolName = isRequest ? detail?.toolName : undefined;
  const method = isRequest ? detail?.method : undefined;
  const argumentsJson = isRequest ? detail?.argumentsJson : undefined;
  const overheadUs = isRequest ? detail?.overheadUs : undefined;

  return (
    <div
      ref={drawerRef}
      className={styles['drawer']}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <div className={styles['header']}>
        <span className={styles['timestamp']}>{formatTimestamp(row.ts)}</span>
        <Badge severity={row.severity} />
        <span id={headingId} className={styles['category']}>
          {categoryLabel(row.category, row.method)}
        </span>
        <button
          className={styles['closeButton']}
          onClick={onClose}
          aria-label="Close drawer"
          type="button"
        >
          ×
        </button>
      </div>

      <div className={styles['body']}>
        {state.kind === 'loading' && (
          <div className={styles['emptyFindings']}>Loading details…</div>
        )}

        {state.kind === 'unavailable' && (
          <div className={styles['emptyFindings']}>
            Details are no longer available — this event’s session log was removed.
          </div>
        )}

        {detail !== null && (
          <>
            <section className={styles['block']}>
              <div className={styles['blockLabel']}>Tool call</div>
              <div className={styles['kvList']}>
                {toolName !== undefined && (
                  <div className={styles['kvRow']}>
                    <span className={styles['kvKey']}>tool:</span>
                    <span className={styles['kvValue']}>{toolName}</span>
                  </div>
                )}
                {method !== undefined && (
                  <div className={styles['kvRow']}>
                    <span className={styles['kvKey']}>method:</span>
                    <span className={styles['kvValue']}>{method}</span>
                  </div>
                )}
                <div className={styles['kvRow']}>
                  <span className={styles['kvKey']}>mcp:</span>
                  <span className={styles['kvValue']}>{detail.mcp}</span>
                </div>
                <div className={styles['kvRow']}>
                  <span className={styles['kvKey']}>direction:</span>
                  <span className={styles['kvValue']}>{detail.direction}</span>
                </div>
              </div>
            </section>

            {argumentsJson !== undefined && (
              <section className={styles['block']}>
                <div className={styles['blockLabel']}>Arguments</div>
                <pre className={styles['code']}>{argumentsJson}</pre>
              </section>
            )}

            <section className={styles['block']}>
              <div className={styles['blockLabel']}>Detection</div>
              {detail.findings.length === 0 ? (
                <div className={styles['emptyFindings']}>No findings</div>
              ) : (
                <div className={styles['findings']}>
                  {groupFindings(detail.findings).map((finding) => (
                    <div key={`${finding.type}|${finding.location ?? ''}`} className={styles['finding']}>
                      <span className={styles['findingType']}>{finding.type}</span>
                      {finding.location !== undefined && (
                        <span className={styles['findingMatch']}>{finding.location}</span>
                      )}
                      {finding.count > 1 && (
                        <span className={styles['findingCount']}>×{finding.count}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className={styles['blockCollapsible']}>
              <button
                className={styles['collapsibleToggle']}
                onClick={() => setTechnicalOpen((v) => !v)}
                aria-expanded={technicalOpen}
                type="button"
              >
                <span
                  className={
                    technicalOpen ? `${styles['caret']} ${styles['caretOpen']}` : styles['caret']
                  }
                  aria-hidden="true"
                />
                <span className={styles['blockLabel']}>Technical details</span>
              </button>
              {technicalOpen && (
                <div className={styles['kvList']}>
                  <div className={styles['kvRow']}>
                    <span className={styles['kvKey']}>rpcId:</span>
                    <span className={styles['kvValue']}>{String(detail.rpcId)}</span>
                  </div>
                  <div className={styles['kvRow']}>
                    <span className={styles['kvKey']}>session:</span>
                    <span className={styles['kvValue']}>{detail.session}</span>
                  </div>
                  <div className={styles['kvRow']}>
                    <span className={styles['kvKey']}>source:</span>
                    <span className={styles['kvValue']}>{SOURCE_LABELS[detail.source]}</span>
                  </div>
                  {row.pairedSource !== undefined && (
                    // Cross-source correlation (frente 3): rides on the slim
                    // row, not the detail — assemble computes it over the full
                    // list, which getDetail can't see.
                    <div className={styles['kvRow']}>
                      <span className={styles['kvKey']}>correlation:</span>
                      <span className={styles['kvValue']}>
                        {PAIRED_SOURCE_LABELS[row.pairedSource]}
                      </span>
                    </div>
                  )}
                  {overheadUs !== undefined && (
                    <div className={styles['kvRow']}>
                      <span className={styles['kvKey']}>overheadUs:</span>
                      <span className={styles['kvValue']}>{overheadUs}</span>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <div className={styles['footer']}>
        <button
          className={styles['copyButton']}
          onClick={handleCopyJson}
          type="button"
        >
          Copy as JSON
        </button>
      </div>
    </div>
  );
}

/** Dispatch. Keeps one drawer in the tree and one set of chrome behaviours. */
export function DetailDrawer(props: DetailDrawerProps): JSX.Element | null {
  if (props.row !== undefined) return <DetectionDetailPanel row={props.row} onClose={props.onClose} />;
  if (props.change === null || props.change === undefined) return null;
  return <ChangeDetail change={props.change} onReview={props.onReview} onClose={props.onClose} />;
}
