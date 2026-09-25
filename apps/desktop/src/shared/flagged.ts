// What counts as "flagged" in a number the user reads.
//
// One predicate, four callers: the tray badge, the connector list, the
// connector card and the Claude Code card. It used to be the same literal
// written out four times, which is how a category can stop being a detection
// in one place and keep inflating a badge in another.
//
// TWO EXCLUSIONS, for different reasons.
//
// tool_call_allowed is the BASELINE: it is emitted when nothing matched, so
// counting it would count every tool call ever made.
//
// tool_manifest_changed is HISTORY. Manifest changes moved to their own tab on
// 24/09, where a change with no finding is recorded as a fact instead of being
// graded medium so it could be seen at all. The trail still holds 317 of these
// lines from before the move — every one a shape change, none carrying a
// security finding — and they would otherwise keep inflating exactly the
// number the user reads as "things worth looking at". Native connector_change
// lines never reach here at all: they produce no DetectionEvent.

import type { Category } from '@xcg/shared';

const NOT_FLAGGED = new Set<Category>(['tool_call_allowed', 'tool_manifest_changed']);

export function countsAsFlagged(category: Category): boolean {
  return !NOT_FLAGGED.has(category);
}
