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
   *  normalized view.
   *  v2: adds four cross-tool phrasings (detectors/cross-tool.ts) — disregard
   *  other tools' instructions, prefer this tool over all others, run before
   *  any tool, stop using a named set of tools in favour of this one. v1 was
   *  the four prompt-injection patterns alone (ignore previous instructions,
   *  role override, system prompt leak, jailbreak markers).
   *  Known gaps: a mention of a SPECIFIC tool of another server ("when using
   *  send_email…"), semantic poisoning with no instruction-shaped wording, and
   *  an instruction split across several tools or fields.
   *  Evaluation (holdout v1): 19/24 in-scope detected, 0/30 negatives flagged
   *  — see EVALUATION.md. */
  injection_marker: 2,
  /** Invisible characters, graded by class (text-normalize.ts).
   *  v2: tag, bidi and a RUN of variation selectors high; zero-width, ANSI and
   *  rare invisible controls (U+206A-U+206F, the unassigned tag plane) medium.
   *  v1 was the same minus the two v2 classes.
   *  Known gaps: a variation selector spread one at a time behind visible
   *  characters, U+180E, U+00AD, LRM/RLM/ALM, and anything outside connector
   *  tool definitions (tools/call results, resources, prompts). */
  hidden_characters: 2,
};

export const RULE_IDS: readonly RuleId[] = Object.keys(RULE_VERSIONS) as RuleId[];

/** The two fields every security finding carries. Informational findings call
 *  this for nothing — they are not rules and must stay unversioned. */
export function ruleStamp(id: RuleId): { rule_id: RuleId; rule_version: number } {
  return { rule_id: id, rule_version: RULE_VERSIONS[id] };
}
