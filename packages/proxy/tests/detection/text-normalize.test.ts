// hidden_characters v2: which invisible characters a string carries, graded by
// class. Every class once, then the text that must NOT trip the new classes —
// the emoji, keycaps and ideographic variants that legitimate descriptions use.

import { describe, expect, it } from 'vitest';

import {
  HIDDEN_CLASS_SEVERITY,
  hiddenCharacterHits,
  normalizeForAnalysis,
  type HiddenClass,
} from '../../src/detection/detectors/text-normalize.js';
import { buildManifest, reportChanges, type ToolDef } from '../../src/detection/manifest.js';
import { RULE_VERSIONS } from '../../src/detection/rules.js';

const classes = (text: string): HiddenClass[] => hiddenCharacterHits(text).map((h) => h.cls);

describe('hidden characters — every class, and its severity', () => {
  const CASES: [HiddenClass, string, 'high' | 'medium', string, number][] = [
    ['tag_characters', `ok${String.fromCodePoint(0xe0052, 0xe0065)}`, 'high', 'U+E0052', 2],
    ['bidi_control', 'ok‮evil‬', 'high', 'U+202E', 2],
    ['zero_width', 'o​k', 'medium', 'U+200B', 1],
    ['ansi_escape', 'ok \u001B[31mred\u001B[0m', 'medium', 'U+001B', 2],
    ['variation_selector_run', `inc.︀︁️${String.fromCodePoint(0xe0100)}`, 'high', 'U+FE00', 4],
    ['rare_invisible_control', 'ok⁪ok', 'medium', 'U+206A', 1],
  ];

  for (const [cls, text, severity, codepoint, count] of CASES) {
    it(`${cls}: ${severity}, first codepoint ${codepoint}, count ${count}`, () => {
      expect(hiddenCharacterHits(text)).toEqual([{ cls, codepoint, count }]);
      expect(HIDDEN_CLASS_SEVERITY[cls]).toBe(severity);
    });
  }

  it('the unassigned rest of the tag plane is a rare control, not a tag', () => {
    expect(classes(`ok${String.fromCodePoint(0xe0080)}`)).toEqual(['rare_invisible_control']);
    expect(classes(`ok${String.fromCodePoint(0xe0fff)}`)).toEqual(['rare_invisible_control']);
    expect(classes(`ok${String.fromCodePoint(0xe01f0)}`)).toEqual(['rare_invisible_control']);
  });

  it('the supplementary variation selectors are NOT rare controls', () => {
    // U+E0100-E01EF sits inside the tag plane but is its own block.
    expect(classes(`辻${String.fromCodePoint(0xe0100)}`)).toEqual([]);
  });

  it('a run counts every selector across runs', () => {
    expect(hiddenCharacterHits('a︀︁ b︂︃︄')).toEqual([
      { cls: 'variation_selector_run', codepoint: 'U+FE00', count: 5 },
    ]);
  });

  it('several classes in one string are each reported once', () => {
    expect(classes('‮a​b︀︁')).toEqual(['bidi_control', 'zero_width', 'variation_selector_run']);
  });
});

describe('hidden characters — legitimate text never trips the v2 classes', () => {
  it('an emoji with ONE presentation selector (U+2764 U+FE0F)', () => {
    expect(hiddenCharacterHits('Status: ❤️ done')).toEqual([]);
  });

  it('a keycap (1 U+FE0F U+20E3)', () => {
    expect(hiddenCharacterHits('Step 1️⃣ first')).toEqual([]);
  });

  it('a Japanese ideograph with ONE variation selector (IVS)', () => {
    expect(hiddenCharacterHits(`辻${String.fromCodePoint(0xe0100)}村`)).toEqual([]);
  });

  it('a soft hyphen — a known gap, not flagged', () => {
    expect(hiddenCharacterHits('infor­mation')).toEqual([]);
  });

  it('a ZWJ emoji sequence trips zero_width (unchanged, medium) and nothing new', () => {
    // U+1F469 U+200D U+1F4BB: "woman technologist". The joiner is zero_width,
    // as it was in v1 — medium, and no variation_selector_run.
    expect(classes('Owner: \u{1F469}‍\u{1F4BB}')).toEqual(['zero_width']);
  });

  it('bidi MARKS (LRM, RLM, ALM) are a known gap, not flagged', () => {
    expect(hiddenCharacterHits('a‎b‏c؜d')).toEqual([]);
  });
});

describe('normalizeForAnalysis — unchanged by v2', () => {
  // The two v2 classes are REPORTED, never stripped: what injection_marker and
  // the other matchers see must not move with this rule.
  it('keeps variation-selector runs and rare controls in the analysis view', () => {
    expect(normalizeForAnalysis('a︀︁b')).toBe('a︀︁b');
    expect(normalizeForAnalysis('a⁪b')).toBe('a⁪b');
  });

  it('still strips the four v1 classes', () => {
    expect(normalizeForAnalysis(`a​b‮c${String.fromCodePoint(0xe0052)}\u001B[31md`)).toBe('abcd');
  });
});

describe('hidden_characters v2 — through the connector-change report', () => {
  const tool = (description: string): ToolDef => ({
    name: 'search',
    description,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  });
  const report = (after: string) =>
    reportChanges(buildManifest([tool('Search the workspace.')]), buildManifest([tool(after)]), [tool(after)]);

  it('is at version 2', () => {
    expect(RULE_VERSIONS.hidden_characters).toBe(2);
  });

  it('a variation-selector run is a high finding, stamped v2', () => {
    const r = report('Search the workspace.︀︁️');
    const f = r?.findings.find((x) => x.rule_id === 'hidden_characters');
    expect(f?.severity).toBe('high');
    expect(f?.rule_version).toBe(2);
    expect(f?.evidence.rule).toBe('variation_selector_run');
  });

  it('a rare invisible control is a medium finding', () => {
    const r = report('Search the⁯ workspace.');
    const f = r?.findings.find((x) => x.rule_id === 'hidden_characters');
    expect(f?.severity).toBe('medium');
    expect(f?.evidence.rule).toBe('rare_invisible_control');
  });

  it('an emoji with one selector changes the description and raises nothing', () => {
    const r = report('Search the workspace ✨️.');
    expect(r?.findings.filter((x) => x.rule_id === 'hidden_characters')).toEqual([]);
  });
});
