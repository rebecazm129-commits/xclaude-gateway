// All PII examples in this file are 100% synthetic: documented test vectors
// (jwt.io-style), checksum-constructed values, or reserved example domains.
// No real personal data. Negative cases are deliberately checksum-broken.

import { describe, expect, it } from 'vitest';

import { piiStructured } from '../../src/detection/detectors/pii-structured.js';
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

describe('piiStructured', () => {
  describe('positives', () => {
    it('detects an email and emits category/severity', () => {
      const out = piiStructured(input('{"to":"alice@example.com"}'));
      expect(out?.category).toBe('pii_structured');
      expect(out?.severity).toBe('medium');
      expect(
        out?.findings.some((f) => f.type === 'email' && f.location === 'params'),
      ).toBe(true);
    });

    it('detects a mod-97-valid IBAN (spaced)', () => {
      const out = piiStructured(
        input('{"iban":"ES91 2100 0418 4502 0005 1332"}'),
      );
      expect(out?.findings.some((f) => f.type === 'iban')).toBe(true);
    });

    it('detects a Luhn-valid credit card (test vector 4111111111111111)', () => {
      const out = piiStructured(input('{"card":"4111111111111111"}'));
      expect(out?.findings.some((f) => f.type === 'credit_card')).toBe(true);
    });

    it('detects a Luhn-valid credit card with internal spaces', () => {
      const out = piiStructured(input('{"card":"4111 1111 1111 1111"}'));
      expect(out?.findings.some((f) => f.type === 'credit_card')).toBe(true);
    });

    it('detects a valid US SSN with hyphens', () => {
      const out = piiStructured(input('{"ssn":"123-45-6789"}'));
      expect(out?.findings.some((f) => f.type === 'us_ssn')).toBe(true);
    });

    it('detects a valid UK NINO', () => {
      const out = piiStructured(input('{"nino":"AB123456C"}'));
      expect(out?.findings.some((f) => f.type === 'uk_nino')).toBe(true);
    });

    it('detects a mod-11-valid NHS number (spaced)', () => {
      const out = piiStructured(input('{"nhs":"943 476 5919"}'));
      expect(out?.findings.some((f) => f.type === 'uk_nhs')).toBe(true);
    });

    it('detects a control-letter-valid Spanish DNI', () => {
      const out = piiStructured(input('{"dni":"12345678Z"}'));
      expect(out?.findings.some((f) => f.type === 'es_dni')).toBe(true);
    });

    it('detects a control-letter-valid Spanish NIE', () => {
      const out = piiStructured(input('{"nie":"X1234567L"}'));
      expect(out?.findings.some((f) => f.type === 'es_nie')).toBe(true);
    });

    it('detects an E.164 phone with + prefix and separators', () => {
      const out = piiStructured(input('{"phone":"+34 600 000 000"}'));
      expect(out?.findings.some((f) => f.type === 'phone_e164')).toBe(true);
    });

    it('detects a valid ICAO 9303 TD3 MRZ line 2 (UTOPIA specimen)', () => {
      // Synthetic specimen (country UTO); all 5 check digits computed valid.
      const mrz = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';
      const out = piiStructured(input(`{"mrz":"${mrz}"}`));
      expect(out?.findings.some((f) => f.type === 'mrz_td3')).toBe(true);
    });

    it('detects a valid French NIR (public example, key 32)', () => {
      const out = piiStructured(input('{"nir":"185036912304532"}'));
      expect(out?.findings.some((f) => f.type === 'fr_nir')).toBe(true);
    });

    it('detects a valid Corsican NIR (department 2B)', () => {
      // 2B -> 18 before mod-97; key computed = 37.
      const out = piiStructured(input('{"nir":"200012B12345637"}'));
      expect(out?.findings.some((f) => f.type === 'fr_nir')).toBe(true);
    });

    it('detects a valid Italian codice fiscale (textbook synthetic)', () => {
      const out = piiStructured(input('{"cf":"RSSMRA85T10A562S"}'));
      expect(out?.findings.some((f) => f.type === 'it_codice_fiscale')).toBe(true);
    });

    it('detects a valid Dutch BSN (elfproef)', () => {
      const out = piiStructured(input('{"bsn":"111222333"}'));
      expect(out?.findings.some((f) => f.type === 'nl_bsn')).toBe(true);
    });

    it('detects a valid German Steuer-ID (MOD 11,10 + repeat rule)', () => {
      const out = piiStructured(input('{"steuer":"12345678920"}'));
      expect(out?.findings.some((f) => f.type === 'de_steuer_id')).toBe(true);
    });

    it('detects a valid Portuguese NIF (mod-11, valid first digit)', () => {
      const out = piiStructured(input('{"nif":"500012342"}'));
      expect(out?.findings.some((f) => f.type === 'pt_nif')).toBe(true);
    });
  });

  describe('negatives', () => {
    it('returns null for empty paramsJson', () => {
      expect(piiStructured(input(''))).toBeNull();
    });

    it('returns null for plain prose with no PII shapes', () => {
      expect(
        piiStructured(input('The quick brown fox jumps over the lazy dog.')),
      ).toBeNull();
    });

    it('returns null for an IBAN with one digit changed (mod-97 fails)', () => {
      // ...1333 instead of ...1332: passes the shape regex, fails the checksum.
      expect(
        piiStructured(input('{"iban":"ES91 2100 0418 4502 0005 1333"}')),
      ).toBeNull();
    });

    it('returns null for a Luhn-invalid credit card', () => {
      // 16 digits, correct shape, but Luhn-invalid (last digit 2 not 1).
      expect(piiStructured(input('{"card":"4111111111111112"}'))).toBeNull();
    });

    it('returns null for the real corpus false positive (3-10 digit filename)', () => {
      // Hardening: /tmp/...-123-1234567890.json — non-canonical grouping must
      // be rejected even if the stripped digits happen to pass Luhn.
      expect(
        piiStructured(input('{"path":"/tmp/xcg-cfg-smoke-123-1234567890.json"}')),
      ).toBeNull();
    });

    it('returns null for a TD3 MRZ with a broken composite check digit', () => {
      // Same specimen, composite digit flipped 0 -> 1.
      const mrz = 'L898902C36UTO7408122F1204159ZE184226B<<<<<11';
      expect(piiStructured(input(`{"mrz":"${mrz}"}`))).toBeNull();
    });

    it('returns null for a French NIR with a broken key', () => {
      // ...532 (valid) changed to ...531: wrong key AND not Luhn-valid, so it
      // isn't picked up as a credit_card either.
      expect(piiStructured(input('{"nir":"185036912304531"}'))).toBeNull();
    });

    it('returns null for an Italian codice fiscale with the wrong control letter', () => {
      // ...A562S (valid) changed to ...A562A.
      expect(piiStructured(input('{"cf":"RSSMRA85T10A562A"}'))).toBeNull();
    });

    it('returns null for a Dutch BSN that fails the elfproef', () => {
      expect(piiStructured(input('{"bsn":"111222334"}'))).toBeNull();
    });

    it('returns null for a German Steuer-ID with a broken check digit', () => {
      // 12345678920 valid -> ...921.
      expect(piiStructured(input('{"steuer":"12345678921"}'))).toBeNull();
    });

    it('returns null for a German Steuer-ID failing the repeat rule (all digits distinct)', () => {
      // 12345678903: valid MOD 11,10 checksum and first digit != 0, but the first
      // 10 digits are all distinct -> no digit repeats 2-3 times.
      expect(piiStructured(input('{"steuer":"12345678903"}'))).toBeNull();
    });

    it('returns null for a Portuguese NIF with an invalid first digit', () => {
      // 400000008: valid mod-11 checksum, but first digit 4 is not in {1,2,3,5,6,8,9}.
      expect(piiStructured(input('{"nif":"400000008"}'))).toBeNull();
    });

    it('returns null for a Portuguese NIF with a broken check digit', () => {
      // 500012342 valid -> ...343.
      expect(piiStructured(input('{"nif":"500012343"}'))).toBeNull();
    });

    it('returns null for a DNI with the wrong control letter', () => {
      // 12345678 -> control letter is Z; A is wrong.
      expect(piiStructured(input('{"dni":"12345678A"}'))).toBeNull();
    });

    it('returns null for a NIE with the wrong control letter', () => {
      // X1234567 -> control letter is L; A is wrong.
      expect(piiStructured(input('{"nie":"X1234567A"}'))).toBeNull();
    });

    it('returns null for an SSN with area 000', () => {
      expect(piiStructured(input('{"ssn":"000-45-6789"}'))).toBeNull();
    });

    it('returns null for an SSN with area 666', () => {
      expect(piiStructured(input('{"ssn":"666-45-6789"}'))).toBeNull();
    });

    it('returns null for a NINO with a disallowed prefix (QQ)', () => {
      expect(piiStructured(input('{"nino":"QQ123456C"}'))).toBeNull();
    });

    it('returns null for an NHS number with a broken mod-11 checksum', () => {
      // 9434765918 (last digit 8 not 9): shape ok, checksum fails.
      expect(piiStructured(input('{"nhs":"943 476 5918"}'))).toBeNull();
    });

    it('returns null for a technical config blob with numbers', () => {
      // timeouts, ports, retries, version, conn counts — none are valid PII.
      expect(
        piiStructured(
          input(
            '{"timeout_ms":3000,"retries":5,"port":8080,"version":"1.2.3","maxConns":12345}',
          ),
        ),
      ).toBeNull();
    });
  });
});
