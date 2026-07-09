import { useEffect, useRef, useState } from 'react';

import type { Category, DetectionDetail, DetectionFinding, DetectionRowSlim } from '../../shared/types.js';
import { Badge } from './Badge.js';

import styles from './DetailDrawer.module.css';

const CATEGORY_LABELS: Record<Category, string> = {
  credential_detected: 'Credential leak',
  prompt_injection: 'Prompt injection',
  email_send_warning: 'Email send',
  data_export_warning: 'Data export',
  tool_call_allowed: 'Tool call',
  pii_detected: 'PII detected',
  pii_structured: 'Structured PII',
  tool_manifest_changed: 'Tool manifest changed',
};

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

interface DetailDrawerProps {
  row: DetectionRowSlim;
  onClose: () => void;
}

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

export function DetailDrawer({ row, onClose }: DetailDrawerProps): JSX.Element {
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
          {CATEGORY_LABELS[row.category]}
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
                <span className={styles['caret']}>{technicalOpen ? '▾' : '▸'}</span>
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
