// Lazy v1 → v2 migration, decided per connector the first time it is observed
// after the upgrade.
//
// THE RULE THAT MATTERS. v1 watched `description` and `inputSchema`. Two
// different things can be true when a v2 baseline is first built:
//
//   - the live manifest DIFFERS from the v1 baseline in what v1 watched.
//     That is a real change, detected by the old rules, and it is reported:
//     tool_manifest_changed with the v1 diff, and then the migration happens.
//     Swallowing it "because we were migrating" would lose a genuine finding
//     behind a housekeeping step.
//
//   - fields and sections v1 never watched (title, outputSchema, the intent
//     hints, resources, prompts, discovery…) have NO baseline to compare
//     against. They are recorded as newly covered and NEVER alerted on. There
//     is no honest way to say a field did not change when nothing ever looked
//     at it, and `coverage_expanded` says exactly that.



import { buildManifest, reportChanges, type ChangeReport, extractTools, type Manifest } from './manifest.js';

/** Fields and sections v2 starts watching that v1 never did. Reported with the
 *  migration so the expansion is visible, never as a change. */
export const COVERAGE_EXPANDED: readonly string[] = [
  'tools[].title',
  'tools[].outputSchema',
  'tools[].icons',
  'tools[].annotations.readOnlyHint',
  'tools[].annotations.destructiveHint',
  'tools[].annotations.idempotentHint',
  'tools[].execution',
  'tools[].securitySchemes',
  'tools[]._meta',
  'section:resources',
  'section:resource_templates',
  'section:prompts',
  'section:discovery',
];

export interface MigrationPlan {
  /** A real change in what v1 already watched. Reported BEFORE migrating. */
  /** What the OLD v1 rules already watched and that genuinely moved across
   *  the migration. Reported before migrating: swallowing it as housekeeping
   *  would lose a real change. Null when v1 saw nothing move. */
  v1Change: ChangeReport | null;
  /** Fields now covered that never were. Never a change claim. */
  coverageExpanded: readonly string[];
}

/**
 * Decides what to report when a connector with a v1 baseline is observed for
 * the first time under v2.
 *
 * `prevV1` is the stored v1 baseline; `liveResult` the raw tools/list result.
 * Both are run through the FROZEN v1 algorithm, so this comparison means
 * exactly what it meant before the upgrade.
 */
export function planMigration(prevV1: Manifest | null, liveResult: unknown): MigrationPlan {
  const coverageExpanded = COVERAGE_EXPANDED;
  if (prevV1 === null) {
    // No v1 baseline: nothing was ever watched, so nothing can have changed.
    return { v1Change: null, coverageExpanded };
  }
  const tools = extractTools(liveResult);
  const live = buildManifest(tools);
  if (prevV1.hash === live.hash) {
    // v1's own view is unchanged. The expansion is still reported.
    return { v1Change: null, coverageExpanded };
  }
  // v1's view DID change: a real finding under the old rules, reported with
  // the old diff. Migration follows it, it does not replace it.
  return { v1Change: reportChanges(prevV1, live, tools), coverageExpanded };
}
