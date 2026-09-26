// Analysis view of a string, and the classification of what was hidden in it.
// The ORIGINAL is always kept as evidence - normalisation only feeds matchers.
//
// Three transformations, all aimed at text that reads clean to a human and
// differently to a matcher:
//   NFKC   - compatibility composition, so fullwidth and other presentation
//            forms collapse onto the characters a pattern is written in.
//   strip  - zero-width characters (U+200B-U+200D, U+2060, U+FEFF) and Unicode
//            tag characters (U+E0000-U+E007F). Both are invisible in every
//            surface a person reads a manifest through, and both break a regex
//            written against the visible text.
//   strip  - bidi controls (U+202A-U+202E, U+2066-U+2069) and ANSI escape
//            sequences. They reorder or hide what a reader sees without
//            changing what a machine consumes; removing them makes the matcher
//            see the same sequence the model will.

export type HiddenClass =
  | 'tag_characters'
  | 'bidi_control'
  | 'zero_width'
  | 'ansi_escape'
  | 'variation_selector_run'
  | 'rare_invisible_control';

/** Severity each class justifies on its own.
 *
 *  HIGH for tag characters and bidi controls. Tag characters have no
 *  legitimate use in a tool manifest whatsoever - the block exists to carry
 *  out-of-band data, and a run of them IS a hidden payload. Bidi overrides and
 *  isolates actively lie about reading order: the text a reviewer sees and the
 *  text a model consumes are different strings, which is the whole mechanism.
 *
 *  HIGH for a RUN of variation selectors (two or more in a row). One selector
 *  after a visible character is how emoji and Japanese ideographic variants are
 *  written - U+2764 U+FE0F, a keycap, a kanji with one IVS - and is never
 *  flagged. Two or more back to back select nothing: no base character takes
 *  more than one, so a run is data riding in characters that render as nothing,
 *  the same side channel as a run of tags.
 *
 *  MEDIUM for zero-width and ANSI. Both are invisible, but both turn up by
 *  accident: zero-width joiners ride along in emoji and copied rich text, and
 *  ANSI sequences leak in from terminal output captured into documentation.
 *  Worth reporting, not worth waking someone up on their own.
 *
 *  MEDIUM for rare invisible controls: the deprecated format characters
 *  U+206A-U+206F and the unassigned rest of the tag plane. Nothing legitimate
 *  writes them today, but a single one proves nothing on its own.
 *
 *  KNOWN GAPS, deliberately not covered by this rule (hidden_characters v2):
 *    - a variation selector spread one at a time behind visible characters: each
 *      reads as an ordinary emoji or ideographic variant, so no run exists;
 *    - U+180E (Mongolian vowel separator) and U+00AD (soft hyphen): legitimate
 *      in text, so flagging them alone is noise;
 *    - LRM/RLM/ALM (U+200E, U+200F, U+061C): bidi MARKS, legitimate in any
 *      right-to-left text, unlike the overrides and isolates above;
 *    - only connector TOOL definitions are scanned: not tools/call results,
 *      not resources, not prompts. */
export const HIDDEN_CLASS_SEVERITY: Record<HiddenClass, 'high' | 'medium'> = {
  tag_characters: 'high',
  bidi_control: 'high',
  zero_width: 'medium',
  ansi_escape: 'medium',
  variation_selector_run: 'high',
  rare_invisible_control: 'medium',
};

interface ClassPattern {
  cls: HiddenClass;
  source: string;
}

/** The classes normalizeForAnalysis STRIPS. Kept apart from what is merely
 *  reported, so adding a reported class can never change what injection_marker
 *  and the other matchers see. */
const STRIPPED: readonly ClassPattern[] = [
  { cls: 'tag_characters', source: '[\\u{E0000}-\\u{E007F}]' },
  { cls: 'bidi_control', source: '[\\u202A-\\u202E\\u2066-\\u2069]' },
  { cls: 'zero_width', source: '[\\u200B-\\u200D\\u2060\\uFEFF]' },
  { cls: 'ansi_escape', source: '\\u001B\\[[0-9;]*[A-Za-z]' },
];

/** Reported, NOT stripped (hidden_characters v2).
 *
 *  Both are matched on the NFKC view like the rest; NFKC leaves every variation
 *  selector and every one of these controls untouched (checked on Node 24.15 /
 *  Unicode 17.0, the runtime Electron 42 ships).
 *
 *  UNASSIGNED RANGE. U+E0080-U+E00FF and U+E01F0-U+E0FFF are unassigned as of
 *  Unicode 17.0 - the version the ICU in Electron 42 implements (ICU 78.2). A
 *  later Unicode may assign part of that range; if it does, this pattern keeps
 *  matching those codepoints until someone decides otherwise here. */
const REPORTED_ONLY: readonly ClassPattern[] = [
  { cls: 'variation_selector_run', source: '[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]{2,}' },
  {
    cls: 'rare_invisible_control',
    source: '[\\u206A-\\u206F\\u{E0080}-\\u{E00FF}\\u{E01F0}-\\u{E0FFF}]',
  },
];

const PATTERNS: readonly ClassPattern[] = [...STRIPPED, ...REPORTED_ONLY];

// Built fresh per call rather than kept as module-level /g literals: a global
// regex carries lastIndex across calls and would silently skip every other
// match.
const re = (source: string): RegExp => new RegExp(source, 'gu');

export function normalizeForAnalysis(text: string): string {
  let out = text.normalize('NFKC');
  for (const { source } of STRIPPED) out = out.replace(re(source), '');
  return out;
}

export interface HiddenCharacterHit {
  cls: HiddenClass;
  /** The first codepoint of this class seen in the string, as `U+202E`. */
  codepoint: string;
  /** How many characters of this class the string carries. An ANSI sequence
   *  counts as one occurrence, not one per byte; a run of variation selectors
   *  counts every selector in it. */
  count: number;
}

const codepointOf = (s: string): string => {
  const cp = s.codePointAt(0) ?? 0;
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
};

/** Which classes of invisible character the string carries, with a codepoint
 *  and a count per class. Empty when the text is what it looks like. */
export function hiddenCharacterHits(text: string): HiddenCharacterHit[] {
  const normalized = text.normalize('NFKC');
  const out: HiddenCharacterHit[] = [];
  for (const { cls, source } of PATTERNS) {
    const matches = [...normalized.matchAll(re(source))];
    if (matches.length === 0) continue;
    const count =
      cls === 'variation_selector_run'
        ? matches.reduce((n, m) => n + [...m[0]].length, 0)
        : matches.length;
    out.push({ cls, codepoint: codepointOf(matches[0]![0]), count });
  }
  return out;
}

/** True when the analysis view differs from the original. */
export function hasHiddenCharacters(text: string): boolean {
  return hiddenCharacterHits(text).length > 0;
}
