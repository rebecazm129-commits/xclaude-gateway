// Corpus runner. Measures the manifest detector against a fixed set of cases
// whose truth is recorded independently of what the detector does.
//
// The contract, and why it is not the usual expected-fail:
//   covered        → asserted. If it stops being detected, the build fails.
//   gap            → asserted INVERTED. A gap that starts passing fails the
//                    build, which forces someone to reclassify it to covered
//                    on purpose. That is how the corpus measures progress
//                    instead of quietly absorbing it.
//   not_observable → never executed. These cases are not about this detector;
//                    each records which one could see it.
// A gap is therefore never green-by-omission and never red-as-noise: it is
// reported in the summary line and nowhere else.

import { afterAll, describe, expect, it } from 'vitest';

import { buildManifest, diffManifest } from '../../src/detection/manifest.js';
import type { DetectionBlock } from '@xcg/shared';
import {
  ATTACK,
  NEGATIVES,
  OUT_OF_SCOPE,
  atLeast,
  atMost,
  loadLocalNegatives,
  type Fixture,
} from './types.js';

function run(f: Fixture): DetectionBlock | null {
  const base = f.baseline?.tools ?? [];
  const next = f.changed?.tools ?? [];
  return diffManifest(buildManifest(base), buildManifest(next), next);
}

const types = (d: DetectionBlock | null): string[] => (d?.findings ?? []).map((x) => x.type);

/** Which of the acceptable mechanisms actually caught this case, if any.
 *  `expected_findings` is ANY-OF, not all-of: a case is caught when it reaches
 *  the severity floor through ONE of the mechanisms that would be a legitimate
 *  catch. Requiring every listed finding would grade the detector on which
 *  route it took rather than on whether it caught the thing — the 24/09
 *  measurement had fourteen cases reaching high through
 *  sensitive_path_reference while the fixture happened to predict
 *  injection_marker. */
function caughtBy(f: Fixture, det: DetectionBlock | null): string[] {
  if (det === null) return [];
  const seen = types(det);
  return f.expected_findings.filter((t) => seen.includes(t));
}

/** Did the detector do the RIGHT thing for this case? */
function correct(f: Fixture, det: DetectionBlock | null): boolean {
  if (f.malicious) {
    const min = f.severity.minimum;
    if (min == null) return det !== null;
    if (det === null || !atLeast(det.severity, min)) return false;
    return f.expected_findings.length === 0 || caughtBy(f, det).length > 0;
  }
  const max = f.severity.maximum;
  const seen = types(det);
  if (max == null) return det === null;
  if (det !== null && !atMost(det.severity, max)) return false;
  return f.expected_changes.every((t) => seen.includes(t));
}

const tally = { covered: 0, gaps: 0, notObservable: OUT_OF_SCOPE.length, local: 0 };
/** Which mechanism caught each case — the report, not an assertion. */
const caughtByReport: string[] = [];

function describeCollection(name: string, cases: Fixture[]): void {
  if (cases.length === 0) return;
  describe(name, () => {
    for (const f of cases) {
      const label = `[${f.status}${f.split ? `/${f.split}` : ''}] ${f.id} — ${f.title}`;
      it(label, () => {
        const det = run(f);
        const ok = correct(f, det);
        const by = caughtBy(f, det);
        if (by.length > 0) caughtByReport.push(`${f.id} <- ${by.join(' + ')}`);
        if (f.status === 'covered') {
          tally.covered += 1;
          expect(
            ok,
            `REGRESSION: ${f.id} was covered and no longer is. Got ${det === null ? 'no detection' : `${det.severity} [${types(det).join(', ')}]`}.`,
          ).toBe(true);
        } else {
          tally.gaps += 1;
          expect(
            ok,
            `GAP NOW PASSING: ${f.id} is marked gap but the detector handles it. Reclassify it to "covered" in the fixture — the corpus measures progress by that edit, not by silence.`,
          ).toBe(false);
        }
      });
    }
  });
}

describeCollection('corpus/attack', ATTACK);
describeCollection('corpus/negatives', NEGATIVES);

const LOCAL = loadLocalNegatives();
tally.local = LOCAL.length;
describeCollection('corpus/negatives (local, from the operator trail)', LOCAL);

describe('corpus/out_of_scope', () => {
  // Never executed against the detector: these are recorded so the boundary of
  // what a manifest baseline can see is explicit rather than assumed.
  for (const f of OUT_OF_SCOPE) {
    it(`[not_observable] ${f.id} — seen by: ${f.would_be_seen_by ?? 'nothing'}`, () => {
      expect(f.status).toBe('not_observable');
      expect(f.would_be_seen_by, `${f.id} must record which detector could see it`).toBeTruthy();
    });
  }
});

afterAll(() => {
  const localNote = tally.local > 0 ? `, ${tally.local} local negatives` : ', no local negatives';
  const by = caughtByReport.length > 0 ? `\n  caught_by:\n    ${caughtByReport.join('\n    ')}` : '';
  console.log(
    `\ncorpus v0: ${tally.covered} covered, ${tally.gaps} gaps, ${tally.notObservable} not observable${localNote}` +
      `\n  (a gap that starts passing fails this suite on purpose — reclassify it to covered)${by}\n`,
  );
});
