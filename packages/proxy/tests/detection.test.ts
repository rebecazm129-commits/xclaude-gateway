import { describe, expect, it } from 'vitest';

import { DetectionEngine } from '../src/detection/engine.js';
import type { Detector, McpRequestEnvelope } from '../src/detection/types.js';

const INPUT: McpRequestEnvelope = {
  payload: { hello: 'world' },
  mcp: 'test-mcp',
  method: 'tools/call',
  direction: 'client_to_server',
  sessionId: '01HXTESTSESSION',
};

describe('DetectionEngine', () => {
  it('emits baseline tool_call_allowed when the chain is empty', () => {
    const engine = new DetectionEngine([]);
    const out = engine.detect(INPUT);
    expect(out).toEqual([
      { category: 'tool_call_allowed', severity: 'low', findings: [] },
    ]);
  });

  it('emits baseline when every detector returns null', () => {
    const nullDetector: Detector = () => null;
    const engine = new DetectionEngine([nullDetector, nullDetector]);
    const out = engine.detect(INPUT);
    expect(out).toEqual([
      { category: 'tool_call_allowed', severity: 'low', findings: [] },
    ]);
  });

  it('returns each concrete detector output in order, no baseline', () => {
    const credentialDetector: Detector = () => ({
      category: 'credential_detected',
      severity: 'high',
      findings: [{ type: 'aws_access_key_id', location: 'params.body' }],
    });
    const emailDetector: Detector = () => ({
      category: 'email_send_warning',
      severity: 'medium',
      findings: [{ type: 'recipient_external' }],
    });
    const engine = new DetectionEngine([credentialDetector, emailDetector]);
    const out = engine.detect(INPUT);
    expect(out).toHaveLength(2);
    expect(out[0]?.category).toBe('credential_detected');
    expect(out[0]?.severity).toBe('high');
    expect(out[1]?.category).toBe('email_send_warning');
    expect(out[1]?.severity).toBe('medium');
    expect(out.some((o) => o.category === 'tool_call_allowed')).toBe(false);
  });
});
