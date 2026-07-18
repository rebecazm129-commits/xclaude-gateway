// Plan computation for Claude Code config — F2.1b. Crosses the classified
// entries (./classify.ts) with the caller's intent (wrap/unwrap) and emits
// one explicit action per entry. The plan is an inspectable VALUE and part
// of the module's contract: F2.4 renders it in UI, so the skip reasons are
// stable API, not an implementation detail. Descriptive only — ./apply.ts
// consumes it; nothing here mutates or writes.
//
// computePlan is the ONLY gate to transform's raw wrapEntry/unwrapEntry
// (decision B, F2.1b re-audit): action 'wrap' is emitted only when
// isAlreadyWrapped is false, 'unwrap' only when it is true. unwrapEntry on a
// non-wrapped entry silently corrupts it (command '', args []) — the
// negative test in tests/config-cc/plan.test.ts pins that hazard.
//
// Re-homing (F2.2, closes the decision deferred from F2.1b): a wrapped entry
// whose command points at a stale non-canonical xcg-proxy path (e.g. a dead
// dev-tree bin) gets an explicit 'rehome' action — same contract as
// transform.ts applyWrap's re-homing branch: ONLY command is rewritten.
// Precedences: rehome is emitted under the WRAP intent in the enabled branch
// (it replaces what would otherwise be skip already-wrapped); under the
// UNWRAP intent, unwrap wins — restoring the user's original always takes
// precedence, and unwrapEntry never reads command, so a stale command
// unwraps correctly. Gating still wins over rehome: a disabled/pending
// wrapped entry is NOT touched even with a stale command (fail-safe, same
// discipline as every other action). The canonical xcgPath is the CALLER's
// decision (in production the stable symlink, exactly like Desktop) — this
// module receives it, never resolves it. Like the skip reasons, 'rehome' is
// stable API for the F2.4 UI.

import { isAlreadyWrapped } from '../config/parser.js';
import type { CcClassifiedEntry, CcServerEntry } from './types.js';

export type CcIntent = 'wrap' | 'unwrap';

// Why an entry is skipped. disabled/pending/unsupported mirror the
// classification statuses; already-wrapped / not-wrapped mean "already in
// the desired state" for the wrap / unwrap intent respectively.
export type CcSkipReason =
  | 'disabled'
  | 'pending'
  | 'unsupported'
  | 'already-wrapped'
  | 'not-wrapped';

// One action per entry, discriminated by `action`. `entry` is carried for
// inspection (F2.4 UI shows what each action touches); ./apply.ts transforms
// the value inside `raw`, not this projection.
export type CcPlanAction =
  | { action: 'wrap'; name: string; entry: CcServerEntry }
  | { action: 'unwrap'; name: string; entry: CcServerEntry }
  | { action: 'rehome'; name: string; entry: CcServerEntry }
  | { action: 'skip'; name: string; reason: CcSkipReason; entry: CcServerEntry };

export interface CcPlan {
  intent: CcIntent;
  actions: readonly CcPlanAction[];
}

function isWrapped(entry: CcServerEntry): boolean {
  return isAlreadyWrapped(entry.command ?? '', entry.args ?? []);
}

// xcgPath is the canonical wrapper binary this plan considers "home" — the
// rehome decision compares entry.command against it. REQUIRED on purpose: an
// optional default would silently disable re-homing.
export function computePlan(
  entries: readonly CcClassifiedEntry[],
  intent: CcIntent,
  xcgPath: string,
): CcPlan {
  const actions = entries.map((e): CcPlanAction => {
    const { name, entry } = e;
    // unsupported first, for both intents: an http/sse/commandless entry is
    // never actionable, and it can never be wrapped either — 'unsupported'
    // is the truthful reason, not 'not-wrapped'.
    if (e.status === 'unsupported') return { action: 'skip', name, reason: 'unsupported', entry };
    if (intent === 'wrap') {
      if (e.status === 'disabled') return { action: 'skip', name, reason: 'disabled', entry };
      if (e.status === 'pending') return { action: 'skip', name, reason: 'pending', entry };
      // enabled: wrap what is not ours; re-home ours when its command points
      // at a stale non-canonical path; otherwise it is already in place.
      if (isWrapped(entry)) {
        if (entry.command !== xcgPath) return { action: 'rehome', name, entry };
        return { action: 'skip', name, reason: 'already-wrapped', entry };
      }
      return { action: 'wrap', name, entry };
    }
    // unwrap intent: restoring the user's original is always safe, so the
    // gating status (enabled/disabled/pending) does not block it — the only
    // gate is being wrapped at all.
    if (isWrapped(entry)) return { action: 'unwrap', name, entry };
    return { action: 'skip', name, reason: 'not-wrapped', entry };
  });
  return { intent, actions };
}
