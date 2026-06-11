// All email send examples in this file are constructed for testing. None
// reference real recipients or real send actions.

import { describe, expect, it } from 'vitest';

import { emailSendWarning } from '../../src/detection/detectors/email-send-warning.js';
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

function toolInput(toolName: string, paramsJson = ''): DetectorInput {
  return {
    paramsJson,
    toolName,
    envelope: {
      payload: undefined,
      mcp: 'test-mcp',
      method: 'tools/call',
      direction: 'client_to_server',
      sessionId: '01HXTESTSESSION',
    },
  };
}

describe('emailSendWarning', () => {
  describe('positives (EN)', () => {
    it('detects "send email to <recipient>"', () => {
      const out = emailSendWarning(input('send email to alice@example.com'));
      expect(out?.category).toBe('email_send_warning');
      expect(out?.severity).toBe('high');
      expect(
        out?.findings.some((f) => f.type === 'email_send_command' && f.location === 'params'),
      ).toBe(true);
    });

    it('detects "compose an email to <recipient> for <purpose>"', () => {
      const out = emailSendWarning(
        input('Please compose an email to the team for the kickoff.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "draft an email saying <content>"', () => {
      const out = emailSendWarning(input('draft an email saying we are delayed'));
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "write a message that says <content>"', () => {
      const out = emailSendWarning(
        input('write a message that says my account is locked'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Send mail to <recipient> with details"', () => {
      const out = emailSendWarning(
        input('Send mail to support@xyz with the details.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Send the email to <recipient>" (definite article)', () => {
      const out = emailSendWarning(
        input('Send the email to mike@example.com with the quarterly numbers.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Write this message to <recipient>" (demonstrative)', () => {
      const out = emailSendWarning(
        input('Write this message to alice for the project.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Compose my email to <recipient>" (possessive)', () => {
      const out = emailSendWarning(
        input("Compose my email to support saying I'm locked out."),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });
  });

  describe('positives (ES)', () => {
    it('detects "Envía un correo a <destinatario>"', () => {
      const out = emailSendWarning(
        input('Envía un correo a Juan con el reporte mensual.'),
      );
      expect(out?.category).toBe('email_send_warning');
      expect(out?.severity).toBe('high');
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Manda un mensaje para <destinatario> diciendo <contenido>"', () => {
      const out = emailSendWarning(
        input('Manda un mensaje para el equipo diciendo que hay retraso.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Redacta un correo a <destinatario> que diga <contenido>"', () => {
      const out = emailSendWarning(
        input('Redacta un correo a marketing que diga que el reporte está listo.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Escribe un email para <destinatario> diciendo <contenido>"', () => {
      const out = emailSendWarning(
        input('Escribe un email para la directiva diciendo que cerramos.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Envia mensaje a <destinatario>" (without accent)', () => {
      const out = emailSendWarning(input('Envia mensaje a soporte.'));
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Envía el correo a <destinatario>" (artículo definido)', () => {
      const out = emailSendWarning(
        input('Envía el correo a Juan con el reporte mensual.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Manda este mensaje a <destinatario>" (demostrativo)', () => {
      const out = emailSendWarning(
        input('Manda este mensaje a marketing diciendo que está listo.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });

    it('detects "Escribe mi email para <destinatario>" (posesivo)', () => {
      const out = emailSendWarning(
        input('Escribe mi email para la directiva diciendo que cerramos.'),
      );
      expect(out?.findings.some((f) => f.type === 'email_send_command')).toBe(true);
    });
  });

  describe('negatives', () => {
    it('returns null for empty paramsJson', () => {
      expect(emailSendWarning(input(''))).toBeNull();
    });

    it('returns null for plain prose with no email shape', () => {
      expect(
        emailSendWarning(input('The quick brown fox jumps over the lazy dog.')),
      ).toBeNull();
    });

    it('returns null for EN noun mention without verb', () => {
      expect(
        emailSendWarning(input('My email address is alice@example.com.')),
      ).toBeNull();
    });

    it('returns null for EN verb with unrelated noun', () => {
      expect(emailSendWarning(input('Send a request to the team.'))).toBeNull();
    });

    it('returns null for EN missing preposition / saying clause', () => {
      expect(emailSendWarning(input('Send email immediately.'))).toBeNull();
    });

    it('returns null for ES noun mention without verb', () => {
      expect(emailSendWarning(input('Recibí un correo de Juan.'))).toBeNull();
    });

    it('returns null for ES verb with unrelated noun', () => {
      expect(emailSendWarning(input('Envía un saludo a Juan.'))).toBeNull();
    });

    it('returns null for ES missing preposition / diciendo clause', () => {
      expect(emailSendWarning(input('Envía mensaje urgente.'))).toBeNull();
    });

    it('returns null for possessive email mention without send verb', () => {
      expect(emailSendWarning(input('Your email reached me yesterday.'))).toBeNull();
    });

    it('returns null for definite article email mention without send verb', () => {
      expect(emailSendWarning(input('The email server is down.'))).toBeNull();
    });
  });

  describe('tool-name branch', () => {
    it('create_draft (Gmail) → medium, email_compose_tool', () => {
      const out = emailSendWarning(toolInput('create_draft'));
      expect(out?.category).toBe('email_send_warning');
      expect(out?.severity).toBe('medium');
      expect(out?.findings).toEqual([{ type: 'email_compose_tool', location: 'tool' }]);
    });

    it('send_email → high, email_send_tool', () => {
      const out = emailSendWarning(toolInput('send_email'));
      expect(out?.severity).toBe('high');
      expect(out?.findings).toEqual([{ type: 'email_send_tool', location: 'tool' }]);
    });

    it('sendEmail (camelCase) → high, email_send_tool', () => {
      const out = emailSendWarning(toolInput('sendEmail'));
      expect(out?.severity).toBe('high');
      expect(out?.findings.some((f) => f.type === 'email_send_tool')).toBe(true);
    });

    it.each(['label_message', 'unlabel_message', 'write_file', 'search_threads'])(
      'does not fire on %s (no send/compose token)',
      (name) => {
        expect(emailSendWarning(toolInput(name))).toBeNull();
      },
    );

    it('combined: text "send an email to..." + create_draft → ONE output, high, BOTH findings', () => {
      const out = emailSendWarning(toolInput('create_draft', 'send an email to alice@example.com'));
      expect(out?.severity).toBe('high'); // text high > compose medium
      expect(out?.findings.map((f) => f.type).sort()).toEqual([
        'email_compose_tool',
        'email_send_command',
      ]);
    });

    it('toolName undefined + matching text → unchanged text-only behavior', () => {
      const out = emailSendWarning(input('send an email to alice@example.com'));
      expect(out?.severity).toBe('high');
      expect(out?.findings).toEqual([{ type: 'email_send_command', location: 'params' }]);
    });
  });
});
