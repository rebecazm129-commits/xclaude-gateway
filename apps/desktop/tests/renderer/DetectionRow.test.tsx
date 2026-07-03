// @vitest-environment jsdom
// Component tests for the tool label column of DetectionRow, plus the default
// category-filter membership. CSS modules are not processed under vitest, so
// assertions are by rendered text, not hashed class names.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DetectionRow } from '../../src/renderer/components/DetectionRow.js';
import { CATEGORY_OPTIONS } from '../../src/renderer/components/Detections.js';
import type { DetectionRowSlim } from '../../src/shared/types.js';

afterEach(cleanup);

function row(over: Partial<DetectionRowSlim> = {}): DetectionRowSlim {
  return {
    id: 'e1',
    ts: '2026-07-03T00:00:00.000Z',
    mcp: 'notion',
    type: 'mcp.detection_enrichment',
    category: 'pii_detected',
    severity: 'low',
    ...over,
  };
}

describe('DetectionRow — tool column', () => {
  it('shows the tool name for a request row (never [NER])', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.request',
          category: 'tool_call_allowed',
          toolName: 'echo',
          method: 'tools/call',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('echo')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });

  it('shows [NER] for a NER (pii_detected) enrichment row', () => {
    render(
      <DetectionRow
        row={row({ type: 'mcp.detection_enrichment', category: 'pii_detected' })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('[NER]')).toBeTruthy();
  });

  it('shows tools/list (never [NER]) for a tool_manifest_changed enrichment', () => {
    render(
      <DetectionRow
        row={row({
          type: 'mcp.detection_enrichment',
          category: 'tool_manifest_changed',
          severity: 'high',
        })}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('tools/list')).toBeTruthy();
    expect(screen.queryByText('[NER]')).toBeNull();
  });
});

describe('Detections CATEGORY_OPTIONS', () => {
  it('includes tool_manifest_changed so it is filtered-in by default', () => {
    expect(CATEGORY_OPTIONS).toContain('tool_manifest_changed');
    expect(CATEGORY_OPTIONS).toHaveLength(8);
  });
});
