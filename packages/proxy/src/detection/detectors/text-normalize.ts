// Analysis view of a string. The ORIGINAL is always kept as evidence - this is
// only what the patterns are matched against.
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

/** Zero-width, bidi controls and Unicode tag characters. */
const INVISIBLE_SOURCE =
  '[\\u200B-\\u200D\\u2060\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]|[\\u{E0000}-\\u{E007F}]';
/** CSI / SGR escape sequences. */
const ANSI_SOURCE = '\\u001B\\[[0-9;]*[A-Za-z]';

// Built fresh per call rather than kept as module-level /g literals: a global
// regex carries lastIndex across .test() calls and would silently skip every
// other match.
const invisibleRe = (): RegExp => new RegExp(INVISIBLE_SOURCE, 'gu');
const ansiRe = (): RegExp => new RegExp(ANSI_SOURCE, 'gu');

export function normalizeForAnalysis(text: string): string {
  return text.normalize('NFKC').replace(invisibleRe(), '').replace(ansiRe(), '');
}

/** True when the analysis view differs from the original - i.e. the string
 *  carries characters a reader cannot see. Reported as evidence, never as a
 *  verdict on its own. */
export function hasHiddenCharacters(text: string): boolean {
  return normalizeForAnalysis(text) !== text.normalize('NFKC');
}
