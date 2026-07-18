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
// Re-homing (applyWrap's rewrite of an already-wrapped entry whose command
// points at a stale non-canonical xcg-proxy path) is deliberately OUT of
// F2.1b — decision deferred to F2.2.

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
  | { action: 'skip'; name: string; reason: CcSkipReason; entry: CcServerEntry };

export interface CcPlan {
  intent: CcIntent;
  actions: readonly CcPlanAction[];
}

function isWrapped(entry: CcServerEntry): boolean {
  return isAlreadyWrapped(entry.command ?? '', entry.args ?? []);
}

export function computePlan(entries: readonly CcClassifiedEntry[], intent: CcIntent): CcPlan {
  const actions = entries.map((e): CcPlanAction => {
    const { name, entry } = e;
    // unsupported first, for both intents: an http/sse/commandless entry is
    // never actionable, and it can never be wrapped either — 'unsupported'
    // is the truthful reason, not 'not-wrapped'.
    if (e.status === 'unsupported') return { action: 'skip', name, reason: 'unsupported', entry };
    if (intent === 'wrap') {
      if (e.status === 'disabled') return { action: 'skip', name, reason: 'disabled', entry };
      if (e.status === 'pending') return { action: 'skip', name, reason: 'pending', entry };
      // enabled: wrap only what is not already ours.
      if (isWrapped(entry)) return { action: 'skip', name, reason: 'already-wrapped', entry };
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
