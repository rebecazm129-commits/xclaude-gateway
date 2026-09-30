// The drawer body for a connector change.
//
// Follows the detection drawer element for element — same header, same
// `block` / `blockLabel` sections, same `kvList` key/value rows, same grey
// `code` slab, same collapsible Technical details, same footer buttons — and
// uses its stylesheet rather than one of its own. A second visual grammar for
// a second kind of row would make the product feel like two products, and the
// two panels would drift the moment one of them got a fix.
//
// The only thing this file decides is WHICH facts go in which block.

import { useEffect, useRef, useState } from 'react';

import type { ConnectorChangeView } from '../lib/xcgApi.js';
import { topSeverity } from '../hooks/useChangePage.js';
import { Badge } from './Badge.js';
import { ChangeDiff } from './ChangeDiff.js';
import {
  SCOPE_SOURCE_ASSUMED_TEXT,
  SECTION_LABELS,
  SERVER_FALLBACK_TEXT,
  severityDisclaimer,
  changeTitle,
  historicalNote,
  humanSummary,
  itemLines,
  scopeList,
} from './change-copy.js';
import { formatTimestamp } from './detections-format.js';

import styles from './DetailDrawer.module.css';
import footer from './AuditFooter.module.css';

interface Props {
  change: ConnectorChangeView;
  onReview: (change: ConnectorChangeView) => void;
  /** The review-status write is in flight: the button waits. */
  reviewPending?: boolean;
  /** A failed write, said above the footer. */
  reviewError?: string | null;
  onClose: () => void;
}

/** One key/value row of the drawer grammar. */
function Kv({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className={styles['kvRow']}>
      <span className={styles['kvKey']}>{k}:</span>
      <span className={styles['kvValue']}>{v}</span>
    </div>
  );
}

/** "before → now", or just "now" when nothing moved or there is no before. */
function beforeNow(before: string | null, now: string, moved: boolean): string {
  return moved && before !== null ? `${before} → ${now}` : now;
}

/** The Change block of an authorization row: the server and the scopes before
 *  → now, what was added and removed, and when the two logins happened. The
 *  resource only when it moved — otherwise it is in Technical details. */
function AuthorizationChange({ change }: { change: ConnectorChangeView }): JSX.Element | null {
  const a = change.authorization;
  if (a === undefined) return null;
  const serverMoved = a.authorization_server.before !== null && a.authorization_server.before !== a.authorization_server.now;
  const scopesMoved = a.scopes.added.length > 0 || a.scopes.removed.length > 0;
  return (
    <>
      <div className={styles['kvList']}>
        <Kv k="mcp" v={change.mcp} />
        <Kv k="section" v={SECTION_LABELS[change.section]} />
        <Kv k="authorization server" v={beforeNow(a.authorization_server.before, a.authorization_server.now, serverMoved)} />
        <Kv
          k="scopes"
          v={beforeNow(a.scopes.before === null ? null : scopeList(a.scopes.before), scopeList(a.scopes.now), scopesMoved)}
        />
        {a.scopes.added.length > 0 && <Kv k="added" v={scopeList(a.scopes.added)} />}
        {a.scopes.removed.length > 0 && <Kv k="removed" v={scopeList(a.scopes.removed)} />}
        {a.resource.changed && <Kv k="resource" v={`${a.resource.before ?? 'none'} → ${a.resource.now ?? 'none'}`} />}
        <Kv k="previous login" v={a.previous_login_at === null ? 'none' : formatTimestamp(a.previous_login_at)} />
        <Kv k="this login" v={formatTimestamp(change.ts)} />
      </div>
      {a.scope_source === 'assumed_requested' && <div className={styles['emptyFindings']}>{SCOPE_SOURCE_ASSUMED_TEXT}</div>}
      {a.authorization_server_source === 'server_url_fallback' && (
        <div className={styles['emptyFindings']}>{SERVER_FALLBACK_TEXT}</div>
      )}
    </>
  );
}

/** The review button's words: what it will do, or what it is doing. */
function reviewLabel(change: ConnectorChangeView, pending: boolean): string {
  // During the write the status already shows the target (it moved at the
  // click), so the in-flight word follows it.
  if (pending) return change.review_status === 'reviewed' ? 'Marking…' : 'Unmarking…';
  return change.review_status === 'reviewed' ? 'Mark as unreviewed' : 'Mark as reviewed';
}

/** One line per finding, in the shape the Detection block uses: what matched,
 *  then where. Kept to a sentence — the panel is for triage, not for reading. */
function findingLines(change: ConnectorChangeView): { key: string; type: string; where: string }[] {
  const out = change.findings.map((f) => ({
    key: `${f.rule_id}|${f.evidence.path ?? ''}`,
    type: f.rule_id,
    where:
      f.evidence.path ??
      f.evidence.target ??
      (f.evidence.count !== undefined && change.section === 'authorization' ? `${f.evidence.count} added` : ''),
  }));
  if (change.attention.level === 'review_recommended') {
    out.push({
      key: 'attention',
      type: 'review_recommended',
      where: 'text added to an existing description, one item changed',
    });
  }
  return out;
}

export function ChangeDetail({ change, onReview, reviewPending = false, reviewError = null, onClose }: Props): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const headingId = `drawer-heading-${change.event_id}`;

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  // Open at the top, always. The drawer stays mounted between rows, so without
  // this a long change scrolled down and then a short one opened mid-panel,
  // with SUMMARY above the fold and CHANGE as the first thing you see.
  useEffect(() => {
    const body = drawerRef.current?.querySelector(`.${styles['body']}`);
    if (body instanceof HTMLElement) body.scrollTop = 0;
    setTechnicalOpen(false);
  }, [change.event_id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const severity = topSeverity(change);
  const note = historicalNote(change);
  const findings = findingLines(change);
  const items = itemLines(change);
  const diff = change.descriptionDiff ?? [];

  function handleCopyJson(): void {
    void navigator.clipboard?.writeText(JSON.stringify(change, null, 2));
  }

  return (
    <div
      className={styles['drawer']}
      ref={drawerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
    >
      <div className={styles['header']}>
        <span className={styles['timestamp']}>{formatTimestamp(change.ts)}</span>
        <Badge
          severity={severity ?? (change.attention.level === 'review_recommended' ? 'review' : 'none')}
        />
        <span id={headingId} className={styles['category']}>
          {changeTitle(change)}
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
          <div className={styles['blockLabel']}>Summary</div>
          <div className={styles['kvValue']}>{humanSummary(change)}</div>
          {note !== null ? <div className={styles['emptyFindings']}>{note}</div> : null}
        </section>

        {change.authorization !== undefined ? (
          <section className={styles['block']}>
            <div className={styles['blockLabel']}>Change</div>
            <AuthorizationChange change={change} />
          </section>
        ) : (
        <section className={styles['block']}>
          <div className={styles['blockLabel']}>Change</div>
          <div className={styles['kvList']}>
            <div className={styles['kvRow']}>
              <span className={styles['kvKey']}>mcp:</span>
              <span className={styles['kvValue']}>{change.mcp}</span>
            </div>
            <div className={styles['kvRow']}>
              <span className={styles['kvKey']}>section:</span>
              <span className={styles['kvValue']}>{SECTION_LABELS[change.section]}</span>
            </div>
          </div>
          {/* One human line per item. The internal kinds are the record, not
              the explanation, so they live in Technical details. */}
          <div className={styles['itemList']}>
            {items.map((item) => (
              <div key={item.target} className={styles['itemLine']}>
                <span className={styles['itemTarget']}>{item.target}</span>
                <span className={styles['itemDash']}> — </span>
                {item.text}
              </div>
            ))}
          </div>
        </section>
        )}

        {/* Only when something asked for a look. On a change nothing flagged,
            a heading asking "why" over "No findings" answers a question the
            panel itself raised. */}
        {findings.length > 0 && (
          <section className={styles['block']}>
            <div className={styles['blockLabel']}>Why this is flagged</div>
            <div className={styles['findings']}>
              {findings.map((f) => (
                <div key={f.key} className={styles['finding']}>
                  <span className={styles['findingType']}>{f.type}</span>
                  {f.where !== '' && <span className={styles['findingMatch']}>{f.where}</span>}
                </div>
              ))}
            </div>
            {/* Fixed sentence, every time. Without it a HIGH pill reads as a
                verdict on the vendor rather than a description of the edit. */}
            <div className={styles['emptyFindings']}>{severityDisclaimer(change)}</div>
          </section>
        )}

        <ChangeDiff diffs={diff} />

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
                <span className={styles['kvKey']}>event_id:</span>
                <span className={styles['kvValue']}>{change.event_id}</span>
              </div>
              {change.authorization !== undefined ? (
                <>
                  <Kv k="resource" v={change.authorization.resource.now ?? 'none'} />
                  <Kv k="requested scopes" v={scopeList(change.authorization.requested_scopes)} />
                  <Kv k="scope source" v={change.authorization.scope_source} />
                  <Kv k="authorization server source" v={change.authorization.authorization_server_source} />
                  {change.authorization.reference_note !== undefined && (
                    <Kv k="reference" v={change.authorization.reference_note} />
                  )}
                </>
              ) : (
                <div className={styles['kvRow']}>
                  <span className={styles['kvKey']}>snapshot:</span>
                  <span className={styles['kvValue']}>
                    {change.snapshot === null
                      ? 'none (recorded by the previous format)'
                      : `${change.snapshot.before ?? 'none'} → ${change.snapshot.after}`}
                  </span>
                </div>
              )}
              <div className={styles['kvRow']}>
                <span className={styles['kvKey']}>section:</span>
                <span className={styles['kvValue']}>{change.section}</span>
              </div>
              {change.changes.map((c, i) => (
                <div key={`${c.kind}|${c.target}|${i}`} className={styles['kvRow']}>
                  <span className={styles['kvKey']}>{c.kind}:</span>
                  <span className={styles['kvValue']}>
                    {c.target}
                    {c.path !== undefined ? `  ${c.path}` : ''}
                  </span>
                </div>
              ))}
              <div className={styles['kvRow']}>
                <span className={styles['kvKey']}>review_status:</span>
                <span className={styles['kvValue']}>{change.review_status}</span>
              </div>
              {change.findings.map((f, i) => (
                <div key={`rule-${i}`} className={styles['kvRow']}>
                  <span className={styles['kvKey']}>rule:</span>
                  <span className={styles['kvValue']}>
                    {f.rule_id} v{f.rule_version} · {f.severity}
                    {f.evidence.rule !== undefined ? ` · ${f.evidence.rule}` : ''}
                    {f.evidence.codepoint !== undefined ? ` · ${f.evidence.codepoint}` : ''}
                  </span>
                </div>
              ))}
              {change.attention.level === 'review_recommended' && (
                <div className={styles['kvRow']}>
                  <span className={styles['kvKey']}>heuristic:</span>
                  <span className={styles['kvValue']}>
                    {change.attention.heuristic_id} v{change.attention.heuristic_version}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {reviewError !== null ? (
        <div className={styles['reviewError']} role="alert">
          {reviewError}
        </div>
      ) : null}
      <div className={styles['footer']}>
        {/* Copy is a utility, so it takes the audit footer's quiet link on the
            left. Review is what the panel is for, so it takes the outline pill
            on the right — the same pill as Export, never a filled button: the
            app has none, and inventing one here would make this panel the
            loudest surface in a product whose posture is "we observed, you
            decide". */}
        <button className={footer['footerLink']} onClick={handleCopyJson} type="button">
          Copy as JSON
        </button>
        <button
          className={styles['copyButton']}
          onClick={() => onReview(change)}
          disabled={reviewPending}
          type="button"
        >
          {reviewLabel(change, reviewPending)}
        </button>
      </div>
    </div>
  );
}
