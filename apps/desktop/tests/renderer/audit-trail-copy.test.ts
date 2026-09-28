// The panel sentence for audit_trail_modification.

import { describe, expect, it } from 'vitest';

import { CATEGORY_LABELS, auditTrailSentences } from '../../src/renderer/components/detections-format.js';

describe('audit_trail_modification copy', () => {
  it('label', () => {
    expect(CATEGORY_LABELS.audit_trail_modification).toBe('Audit trail modification');
  });

  it('one sentence per operation found, write before delete', () => {
    expect(auditTrailSentences('audit_trail_modification', [{ type: 'write' }])).toEqual([
      'Tool call targeted xCLAUDE audit data with a write operation',
    ]);
    expect(auditTrailSentences('audit_trail_modification', [{ type: 'delete' }, { type: 'write' }, { type: 'delete' }])).toEqual([
      'Tool call targeted xCLAUDE audit data with a write operation',
      'Tool call targeted xCLAUDE audit data with a delete operation',
    ]);
  });

  it('nothing for any other category', () => {
    expect(auditTrailSentences('credential_detected', [{ type: 'write' }])).toEqual([]);
  });
});
