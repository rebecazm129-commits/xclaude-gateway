// Tests for connectMessage (renderer formatter shared by AddConnectorModal and
// ConnectorInspector). Pure function, no React/DOM — runs as a plain unit test.
// Covers the success copy split (Added vs Reconnected) and an error kind.

import { describe, expect, it } from 'vitest';

import type { ConnectResult } from '@xcg/shared/config';
import { connectMessage } from '../../src/renderer/components/config-messages.js';

describe('connectMessage', () => {
  it('ok + reconnected:true → "Reconnected" copy', () => {
    const result: ConnectResult = {
      ok: true,
      op: 'connect',
      configPath: '/tmp/claude_desktop_config.json',
      name: 'notion',
      outcome: 'wrote',
      reconnected: true,
    };
    const msg = connectMessage(result);
    expect(msg.tone).toBe('success');
    expect(msg.text).toBe('Reconnected. "notion" was re-authorized.');
  });

  it('ok + reconnected:false → "Added" copy', () => {
    const result: ConnectResult = {
      ok: true,
      op: 'connect',
      configPath: '/tmp/claude_desktop_config.json',
      name: 'notion',
      outcome: 'wrote',
      reconnected: false,
    };
    const msg = connectMessage(result);
    expect(msg.tone).toBe('success');
    expect(msg.text).toBe('Added. "notion" is configured. Restart Claude Desktop to use it.');
  });

  it('error (login-failed) → error tone with retry copy', () => {
    const result: ConnectResult = {
      ok: false,
      error: { kind: 'login-failed', detail: 'boom' },
    };
    const msg = connectMessage(result);
    expect(msg.tone).toBe('error');
    expect(msg.text).toBe('Authorization failed or timed out. Please try again.');
  });
});
