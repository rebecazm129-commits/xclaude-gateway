// The security-rule registry: which rules exist, and what version each is at.
//
// WHY VERSIONS. A finding is a judgement, and a judgement is only
// reproducible if you know what was judging. When `sensitive_param_added`
// changes its token list, or the injection matcher gains a pattern, every
// past finding keeps saying which version decided it — otherwise a re-analysis
// six months from now silently compares two different rules and calls the
// difference a change in the connector.
//
// BUMPING. Adding a rule is additive: give it version 1. Changing what an
// EXISTING rule matches — the token list, a regex, a severity class — requires
// bumping its version here, in the same commit as the change. Renaming a rule
// is not a version bump; it is a new rule, because the id is the identity.
//
// SCOPE. Only security rules live here. external_url, imperative_language and
// external_ref are informational: they never raise severity, so they carry no
// rule_id and are not versioned.

import type { RuleId } from '@xcg/shared';

export const RULE_VERSIONS: Readonly<Record<RuleId, number>> = {
  /** A parameter whose NAME matches the sensitive-token matcher (whole words,
   *  first-position, consecutive pairs and separator-less compounds). */
  sensitive_param_added: 1,
  /** A path-shaped reference to a credential file (~/.ssh/id_rsa, .env…),
   *  recorded by shape, never read. */
  sensitive_path_reference: 1,
  /** An instruction-shaped marker anywhere on the tool surface, matched on the
   *  normalized view. */
  injection_marker: 1,
  /** Invisible characters, graded by class: tag/bidi high, zero-width/ANSI
   *  medium. */
  hidden_characters: 1,
};

export const RULE_IDS: readonly RuleId[] = Object.keys(RULE_VERSIONS) as RuleId[];

/** The two fields every security finding carries. Informational findings call
 *  this for nothing — they are not rules and must stay unversioned. */
export function ruleStamp(id: RuleId): { rule_id: RuleId; rule_version: number } {
  return { rule_id: id, rule_version: RULE_VERSIONS[id] };
}
