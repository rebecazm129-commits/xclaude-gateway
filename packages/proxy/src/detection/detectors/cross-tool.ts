// Cross-tool instructions on a tool's surface — injection_marker v3.
//
// Evaluation (holdout v1, 54 cases written after the v2 freeze): 19/24
// in-scope detected, 0/30 negatives flagged — see EVALUATION.md. v3 widens
// the phrasings by mechanism, using the five v1 misses as development
// examples, so holdout v1 no longer measures it; v3 is not yet evaluated.
//
// Tool poisoning's cross-server form ("shadowing") is a definition that tells
// the model how to treat tools it does not own: disregard what other servers
// say, prefer this tool over all others, run it before anything else, stop
// using a named set of tools. These phrasings are GENERIC — they need no
// knowledge of which other connectors are installed — which is what lets a
// single connector's proxy judge them.
//
// SURFACE ONLY. This is not part of injectionFindings: those patterns also run
// on tool-call params and on tools/call results (prompt_injection, critical),
// where "before calling any tool" is an ordinary thing for a user or a
// document to say. A tool DEFINITION saying it is not.
//
// WHAT IT READS. Text already normalised for analysis (NFKC, invisibles
// stripped), then lowercased, curly apostrophes straightened and whitespace
// collapsed. A name or identifier (a key, or a value with no spaces) is read
// with camelCase split and `_`/`-` as spaces, so `ignore_rules_of_other_tools`
// reads as the sentence it spells. Every gap between words is a bounded
// window — `(?:\W+\w+){0,n}?` — never `.*`.
//
// SCOPE AND GAPS, stated where the rule lives:
//   - no mention of a SPECIFIC tool of another server is detected ("when using
//     send_email, add bcc…"): that needs the other connectors' catalogs;
//   - semantic poisoning with no instruction-shaped wording is not detected;
//   - an instruction split across several tools or fields is not detected;
//   - "never use/call other tools" (P2 in the design) is deliberately absent:
//     real definitions say it legitimately ("do not call other tools to
//     resolve one", "do not call this tool — use another tool").

/** Which cross-tool phrasing matched. Recorded as the finding's `rule`. */
export type CrossToolRule =
  | 'ignore_other_tools'
  | 'prefer_over_other_tools'
  | 'precede_all_tools'
  | 'displace_named_tools';

const OTHER = String.raw`(?:other|another|external|different)`;
const TARGETS = String.raw`(?:tools?|servers?|connectors?)`;
/** Verbs that pick a tool. Deliberately not "rely on", "default to" or "go
 *  with": legitimate definitions say those about their own behaviour. */
const CHOOSE = String.raw`(?:use|call|invoke|select|choose|pick|prefer|opt for)`;
const SELF = String.raw`${CHOOSE}\s(?:this|the current)\s(?:tool|server|connector)\b`;
/** "dont" and "don t" are how an identifier spells it (don_t, dontUse). */
const NEG = String.raw`(?:do not|don't|dont|don t|never)`;
const INSTRUCTIONS = String.raw`(?:instructions?|rules?|guidance|directions?)`;
const ANY_OTHER = String.raw`(?:instead of|rather than)\s(?:(?:using|calling|invoking)\s)?(?:any|all)\s${OTHER}\s${TARGETS}\b`;
/** Up to `n` words between two anchors. */
const gap = (n: number): string => String.raw`(?:\W+\w+){0,${n}}?\W+`;

const PATTERNS: readonly { rule: CrossToolRule; pattern: RegExp }[] = [
  {
    // P1: ignore/disregard … instructions|rules|guidance|directions … from|of|by … other tools,
    // or the object first: ignore/disregard [≤2 words] other tools['s|'] instructions
    rule: 'ignore_other_tools',
    pattern: new RegExp(
      String.raw`\b(?:ignore|disregard)\b${gap(4)}${INSTRUCTIONS}\b${gap(3)}(?:from|of|by)\W+(?:\w+\W+){0,3}?${OTHER}\s${TARGETS}\b` +
        String.raw`|\b(?:ignore|disregard)\b${gap(2)}${OTHER}\s${TARGETS}(?:'s|')?\s${INSTRUCTIONS}\b`,
    ),
  },
  {
    // P3: use|choose|… this tool … instead of / rather than any|all other tools (either order),
    // or "this" with no noun and at most two words before instead of / rather than
    rule: 'prefer_over_other_tools',
    pattern: new RegExp(
      String.raw`\b${SELF}${gap(4)}${ANY_OTHER}` +
        String.raw`|\b${ANY_OTHER}${gap(4)}${SELF}` +
        String.raw`|\b${CHOOSE}\sthis${gap(2)}${ANY_OTHER}`,
    ),
  },
  {
    // P4: before|after calling|using|invoking any|all|every [other] tool
    rule: 'precede_all_tools',
    pattern: new RegExp(String.raw`\b(?:before|after)\s(?:calling|using|invoking)\s(?:any|all|every)\s(?:other\s)?${TARGETS}\b`),
  },
  {
    // P5: do not|don't|dont|never use|call|invoke [the] <X> tools … use|call|invoke this tool
    rule: 'displace_named_tools',
    pattern: new RegExp(
      String.raw`\b${NEG}\s(?:use|call|invoke)\s(?:the\s)?[a-z0-9][a-z0-9_-]*\stools?\b${gap(6)}(?:use|call|invoke)\s(?:this|the current)\stool\b`,
    ),
  },
];

/** The text a cross-tool pattern reads. `normalized` is the walker's analysis
 *  view (NFKC, invisibles stripped); `identifier` says the string is a name. */
export function crossToolText(normalized: string, identifier: boolean): string {
  let s = normalized;
  if (identifier) s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A string with no whitespace reads as a name or identifier. */
export function looksLikeIdentifier(s: string): boolean {
  return s.length > 0 && !/\s/.test(s);
}

/** The first cross-tool phrasing in `text`, or null. */
export function crossToolRule(normalized: string, identifier: boolean): CrossToolRule | null {
  const text = crossToolText(normalized, identifier);
  if (text.length === 0) return null;
  for (const { rule, pattern } of PATTERNS) {
    if (pattern.test(text)) return rule;
  }
  return null;
}
