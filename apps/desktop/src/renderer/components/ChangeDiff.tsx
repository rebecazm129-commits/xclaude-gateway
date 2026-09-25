// "What changed": the summary, the inserted text, and the full diff on demand.
//
// WHY NOT THE WHOLE DIFF IN THE PANEL. A vendor description runs to thousands
// of characters, so a full before/after pushed every other section — the
// findings, the technical details, the review button — below the fold. The
// panel has to answer "what moved" at a glance and stay the same height doing
// it, whatever the vendor wrote.
//
// So the panel shows the COUNT and the INSERTED SEGMENTS ONLY, clamped to
// about five lines. The inserted text is the interesting half: it is what the
// heuristic measured and what an attacker would have added. Everything else is
// one click away and full-window, where it has room.
//
// The segments come from @xcg/shared's wordDiff — the same function the
// heuristic thresholds on, so the highlight and the number can never disagree.

import { useEffect, useState, type ReactElement } from 'react';

// The browser-safe subpath, NOT the barrel: @xcg/shared's index pulls in
// install.ts, which imports node:fs, and the renderer build guard rejects it —
// correctly. A diff of two strings has no business reaching the filesystem.
import { insertedChars, removedChars, toUnifiedText, wordDiff } from '@xcg/shared/word-diff';

import styles from './DetailDrawer.module.css';

export interface DescriptionDiff {
  target: string;
  before: string;
  after: string;
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/** "+212 characters added · 18 removed", or just the half that happened. */
function summaryLine(d: DescriptionDiff): string {
  const added = insertedChars(d.before, d.after);
  const removed = removedChars(d.before, d.after);
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} characters added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return parts.length === 0 ? 'rewritten with no net change' : parts.join(' · ');
}

const segmentsOf = (d: DescriptionDiff, kind: 'added' | 'removed'): string =>
  wordDiff(d.before, d.after)
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The marked-up full diff, added highlighted and removed struck through. */
function FullDiff({ diff }: { diff: DescriptionDiff }): ReactElement {
  return (
    <>
      {wordDiff(diff.before, diff.after).map((seg, i) => {
        if (seg.kind === 'same') return <span key={i}>{seg.text}</span>;
        return (
          <span key={i} className={seg.kind === 'added' ? styles['diffAdded'] : styles['diffRemoved']}>
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

export function ChangeDiff({ diffs }: { diffs: readonly DescriptionDiff[] }): ReactElement | null {
  const [openFull, setOpenFull] = useState(false);

  useEffect(() => {
    if (!openFull) return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // Stop it here: the drawer also closes on Escape, and one press must
        // not dismiss both — you came back from the full diff to the panel you
        // left, at the place you left it.
        e.stopPropagation();
        setOpenFull(false);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [openFull]);

  if (diffs.length === 0) return null;

  const unified = diffs.map((d) => toUnifiedText(d.before, d.after, d.target)).join('\n');
  const allAdded = diffs.map((d) => segmentsOf(d, 'added')).filter((t) => t !== '').join('\n\n');

  return (
    <section className={styles['block']}>
      <div className={styles['blockLabel']}>What changed</div>

      {diffs.map((d) => {
        const added = segmentsOf(d, 'added');
        const removed = segmentsOf(d, 'removed');
        // Only additions are shown when there are any: they are what the
        // heuristic measured. A pure deletion gets the same treatment the
        // other way round.
        const showRemovedInstead = added === '' && removed !== '';
        return (
          <div key={d.target}>
            <div className={styles['kvRow']}>
              <span className={styles['kvKey']}>{diffs.length > 1 ? d.target : 'summary'}:</span>
              <span className={styles['kvValue']}>{summaryLine(d)}</span>
            </div>
            {(added !== '' || removed !== '') && (
              <>
                <div className={styles['blockLabel']} style={{ marginTop: 8 }}>
                  {showRemovedInstead ? 'Removed text' : 'Added text'}
                </div>
                <div className={styles['diffClamp']}>
                  <pre className={`${styles['code']} ${styles['diffFull']}`}>
                    <span className={showRemovedInstead ? styles['diffRemoved'] : styles['diffAdded']}>
                      {showRemovedInstead ? removed : added}
                    </span>
                  </pre>
                </div>
              </>
            )}
          </div>
        );
      })}

      <div className={styles['diffActions']}>
        {allAdded !== '' && (
          <button type="button" className={styles['copyButton']} onClick={() => copy(allAdded)}>
            Copy added text
          </button>
        )}
        {/* "Copy diff" lives only inside the full view. Three buttons under a
            clamped excerpt was one more decision than the moment deserves, and
            copying a diff you have not seen in full is rarely what you meant. */}
        <button type="button" className={styles['copyButton']} onClick={() => setOpenFull(true)}>
          Open full diff
        </button>
      </div>

      {openFull && (
        <div
          className={styles['diffOverlay']}
          role="dialog"
          aria-modal="true"
          aria-label="Full diff"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpenFull(false);
          }}
        >
          <div className={styles['diffSheet']}>
            <div className={styles['header']}>
              <span id="full-diff-heading" className={styles['category']}>
                Full diff{diffs.length === 1 ? ` — ${diffs[0]!.target}` : ''}
              </span>
              <button
                className={styles['closeButton']}
                onClick={() => setOpenFull(false)}
                aria-label="Close full diff"
                type="button"
              >
                ×
              </button>
            </div>
            <div className={styles['diffSheetBody']}>
              {diffs.map((d) => (
                <div key={d.target}>
                  {diffs.length > 1 && <div className={styles['blockLabel']}>{d.target}</div>}
                  <pre className={`${styles['code']} ${styles['diffFull']}`}>
                    <FullDiff diff={d} />
                  </pre>
                </div>
              ))}
            </div>
            <div className={styles['footer']}>
              <button type="button" className={styles['copyButton']} onClick={() => copy(unified)}>
                Copy diff
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
