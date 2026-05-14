// All credential examples in this file are documented fakes (provider docs,
// jwt.io examples, or constructed for testing). No real secrets.

import { describe, expect, it } from 'vitest';

import { credentialDetected } from '../../src/detection/detectors/credential.js';
import type { DetectorInput } from '../../src/detection/types.js';

function input(paramsJson: string): DetectorInput {
  return {
    paramsJson,
    toolName: undefined,
    envelope: {
      payload: undefined,
      mcp: 'test-mcp',
      method: 'tools/call',
      direction: 'client_to_server',
      sessionId: '01HXTESTSESSION',
    },
  };
}

describe('credentialDetected', () => {
  describe('positives', () => {
    it('detects an OpenAI sk- key', () => {
      const out = credentialDetected(
        input('{"key":"sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'),
      );
      expect(out?.category).toBe('credential_detected');
      expect(out?.severity).toBe('critical');
      expect(
        out?.findings.some((f) => f.type === 'openai_api_key' && f.location === 'params'),
      ).toBe(true);
    });

    it('detects an OpenAI sk-proj- key', () => {
      const out = credentialDetected(
        input('{"key":"sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'),
      );
      expect(out?.findings.some((f) => f.type === 'openai_api_key')).toBe(true);
    });

    it('detects an Anthropic sk-ant- key', () => {
      const out = credentialDetected(
        input('{"key":"sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'),
      );
      expect(out?.findings.some((f) => f.type === 'anthropic_api_key')).toBe(true);
    });

    it('detects an AWS AKIA access key', () => {
      const out = credentialDetected(input('{"key":"AKIAIOSFODNN7EXAMPLE"}'));
      expect(out?.findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    });

    it('detects an AWS ASIA temporary access key', () => {
      const out = credentialDetected(input('{"key":"ASIAIOSFODNN7EXAMPLE"}'));
      expect(out?.findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    });

    it('detects an AWS AROA role access key', () => {
      const out = credentialDetected(input('{"key":"AROAIOSFODNN7EXAMPLE"}'));
      expect(out?.findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    });

    it('detects an AWS AIDA user access key', () => {
      const out = credentialDetected(input('{"key":"AIDAIOSFODNN7EXAMPLE"}'));
      expect(out?.findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    });

    it('detects a GitHub ghp_ personal token', () => {
      const out = credentialDetected(
        input('{"key":"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'github_token')).toBe(true);
    });

    it('detects a GitHub ghs_ server token', () => {
      const out = credentialDetected(
        input('{"key":"ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'github_token')).toBe(true);
    });

    it('detects a GitHub gho_ oauth token', () => {
      const out = credentialDetected(
        input('{"key":"gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'github_token')).toBe(true);
    });

    it('detects a GitHub ghu_ user-to-server token', () => {
      const out = credentialDetected(
        input('{"key":"ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'github_token')).toBe(true);
    });

    it('detects a GitHub ghr_ refresh token', () => {
      const out = credentialDetected(
        input('{"key":"ghr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'github_token')).toBe(true);
    });

    it('detects a Stripe sk_live_ secret key', () => {
      const out = credentialDetected(
        input('{"key":"sk_live_aaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'stripe_secret_key')).toBe(true);
    });

    it('detects a Stripe sk_test_ secret key', () => {
      const out = credentialDetected(
        input('{"key":"sk_test_aaaaaaaaaaaaaaaaaaaaaaaa"}'),
      );
      expect(out?.findings.some((f) => f.type === 'stripe_secret_key')).toBe(true);
    });

    it('detects a JWT 3-segment token (jwt.io canonical example)', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const out = credentialDetected(input(`{"token":"${jwt}"}`));
      expect(out?.findings.some((f) => f.type === 'jwt_token')).toBe(true);
    });
  });

  describe('negatives', () => {
    it('returns null for empty paramsJson', () => {
      expect(credentialDetected(input(''))).toBeNull();
    });

    it('returns null for plain prose with no secret-shaped tokens', () => {
      expect(
        credentialDetected(input('The quick brown fox jumps over the lazy dog.')),
      ).toBeNull();
    });

    it('returns null for an OpenAI-like prefix that is too short', () => {
      expect(credentialDetected(input('{"key":"sk-abc123"}'))).toBeNull();
    });

    it('returns null for an Anthropic-like prefix that is too short', () => {
      expect(credentialDetected(input('{"key":"sk-ant-abc"}'))).toBeNull();
    });

    it('returns null for an AWS prefix with fewer than 16 trailing chars', () => {
      expect(credentialDetected(input('{"key":"AKIA1234"}'))).toBeNull();
    });

    it('returns null for a GitHub-like prefix not in [pousr]', () => {
      expect(
        credentialDetected(input('{"key":"ghx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')),
      ).toBeNull();
    });

    it('returns null for a Stripe-like prefix with an unknown env', () => {
      expect(
        credentialDetected(input('{"key":"sk_other_aaaaaaaaaaaaaaaaaaaaaaaa"}')),
      ).toBeNull();
    });

    it('returns null for a JWT-like string with only 2 segments', () => {
      expect(
        credentialDetected(input('{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0"}')),
      ).toBeNull();
    });
  });
});
