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

export type HiddenClass = 'tag_characters' | 'bidi_control' | 'zero_width' | 'ansi_escape';

/** Severity each class justifies on its own.
 *
 *  HIGH for tag characters and bidi controls. Tag characters have no
 *  legitimate use in a tool manifest whatsoever - the block exists to carry
 *  out-of-band data, and a run of them IS a hidden payload. Bidi overrides and
 *  isolates actively lie about reading order: the text a reviewer sees and the
 *  text a model consumes are different strings, which is the whole mechanism.
 *
 *  MEDIUM for zero-width and ANSI. Both are invisible, but both turn up by
 *  accident: zero-width joiners ride along in emoji and copied rich text, and
 *  ANSI sequences leak in from terminal output captured into documentation.
 *  Worth reporting, not worth waking someone up on their own. */
export const HIDDEN_CLASS_SEVERITY: Record<HiddenClass, 'high' | 'medium'> = {
  tag_characters: 'high',
  bidi_control: 'high',
  zero_width: 'medium',
  ansi_escape: 'medium',
};

interface ClassPattern {
  cls: HiddenClass;
  source: string;
}

const PATTERNS: readonly ClassPattern[] = [
  { cls: 'tag_characters', source: '[\\u{E0000}-\\u{E007F}]' },
  { cls: 'bidi_control', source: '[\\u202A-\\u202E\\u2066-\\u2069]' },
  { cls: 'zero_width', source: '[\\u200B-\\u200D\\u2060\\uFEFF]' },
  { cls: 'ansi_escape', source: '\\u001B\\[[0-9;]*[A-Za-z]' },
];

// Built fresh per call rather than kept as module-level /g literals: a global
// regex carries lastIndex across calls and would silently skip every other
// match.
const re = (source: string): RegExp => new RegExp(source, 'gu');

export function normalizeForAnalysis(text: string): string {
  let out = text.normalize('NFKC');
  for (const { source } of PATTERNS) out = out.replace(re(source), '');
  return out;
}

export interface HiddenCharacterHit {
  cls: HiddenClass;
  /** The first codepoint of this class seen in the string, as `U+202E`. */
  codepoint: string;
  /** How many characters of this class the string carries. An ANSI sequence
   *  counts as one occurrence, not one per byte. */
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
    out.push({ cls, codepoint: codepointOf(matches[0]![0]), count: matches.length });
  }
  return out;
}

/** True when the analysis view differs from the original. */
export function hasHiddenCharacters(text: string): boolean {
  return hiddenCharacterHits(text).length > 0;
}
