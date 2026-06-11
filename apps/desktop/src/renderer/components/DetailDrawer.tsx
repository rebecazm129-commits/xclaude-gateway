import { useEffect, useRef, useState } from 'react';

import type { Category, EnrichableEvent } from '../../shared/types.js';
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
  event: EnrichableEvent;
  onClose: () => void;
}

export function DetailDrawer({ event, onClose }: DetailDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const headingId = `drawer-heading-${event.id}`;
  const [technicalOpen, setTechnicalOpen] = useState(false);

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

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

  function handleCopyJson(): void {
    void navigator.clipboard.writeText(JSON.stringify(event, null, 2));
  }

  const isRequest = event.type === 'mcp.request';
  const toolName = isRequest ? event.toolName : undefined;
  const method = isRequest ? event.method : undefined;
  const argumentsJson = isRequest ? event.argumentsJson : undefined;
  const overheadUs = isRequest ? event.overheadUs : undefined;

  return (
    <div
      ref={drawerRef}
      className={styles['drawer']}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <div className={styles['header']}>
        <span className={styles['timestamp']}>{formatTimestamp(event.ts)}</span>
        <Badge severity={event.detection.severity} />
        <span id={headingId} className={styles['category']}>
          {CATEGORY_LABELS[event.detection.category]}
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
              <span className={styles['kvValue']}>{event.mcp}</span>
            </div>
            <div className={styles['kvRow']}>
              <span className={styles['kvKey']}>direction:</span>
              <span className={styles['kvValue']}>{event.direction}</span>
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
          {event.detection.findings.length === 0 ? (
            <div className={styles['emptyFindings']}>No findings</div>
          ) : (
            <div className={styles['findings']}>
              {event.detection.findings.map((finding, idx) => (
                <div key={idx} className={styles['finding']}>
                  <span className={styles['findingType']}>{finding.type}</span>
                  {finding.location !== undefined && (
                    <span className={styles['findingMatch']}>{finding.location}</span>
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
                <span className={styles['kvValue']}>{String(event.rpcId)}</span>
              </div>
              <div className={styles['kvRow']}>
                <span className={styles['kvKey']}>session:</span>
                <span className={styles['kvValue']}>{event.session}</span>
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
