// Pure label contract. categoryLabel exists because the baseline category is
// emitted for EVERY request method (engine.ts emitDetections), not just
// tools/call — so the label has to be method-aware or it lies.

import { describe, expect, it } from 'vitest';

import { CATEGORY_LABELS, categoryLabel } from '../../src/renderer/components/detections-format.js';

describe('categoryLabel', () => {
  it('tools/call keeps the real label', () => {
    expect(categoryLabel('tool_call_allowed', 'tools/call')).toBe('Tool call');
  });

  it('every other method reads as a protocol call', () => {
    for (const m of ['initialize', 'tools/list', 'resources/list', 'prompts/list', 'resources/read']) {
      expect(categoryLabel('tool_call_allowed', m)).toBe('Protocol call');
    }
  });

  it('an unknown future method is covered without a code change', () => {
    // server/discover (MCP 2026-07-28) came through the proxy labelled
    // "Tool call" in the compatibility probe; anything unrecognised must not.
    expect(categoryLabel('tool_call_allowed', 'server/discover')).toBe('Protocol call');
    expect(categoryLabel('tool_call_allowed', 'subscriptions/listen')).toBe('Protocol call');
  });

  it('no method (enrichment rows) falls back to the category label', () => {
    expect(categoryLabel('tool_call_allowed')).toBe('Tool call');
    expect(categoryLabel('tool_call_allowed', undefined)).toBe('Tool call');
  });

  it('leaves every other category untouched, method or not', () => {
    for (const c of Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]) {
      if (c === 'tool_call_allowed') continue;
      expect(categoryLabel(c, 'initialize')).toBe(CATEGORY_LABELS[c]);
      expect(categoryLabel(c)).toBe(CATEGORY_LABELS[c]);
    }
  });
});
