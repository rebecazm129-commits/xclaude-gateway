// Shared formatters for config IPC results, used by both the Connectors view
// (error panel) and the Settings drawer (install/uninstall feedback). Pure,
// no state, no node imports — safe for the renderer.

import type { ConnectResult } from '@xcg/shared/config';

// Format error.kind for the inline error panel. Detail comes through verbatim.
export function errorMessage(err: { kind: string; detail?: string }): string {
  switch (err.kind) {
    case 'not-found':
      return 'claude_desktop_config.json was not found. Open Claude Desktop and add at least one MCP server first.';
    case 'invalid-json':
      return `claude_desktop_config.json is not valid JSON. ${err.detail ?? ''}`.trim();
    case 'unexpected-shape':
      return `claude_desktop_config.json has an unexpected shape. ${err.detail ?? ''}`.trim();
    case 'unreadable':
      return err.detail ?? 'Could not read claude_desktop_config.json.';
    default:
      return 'An unexpected error occurred.';
  }
}

// Map a ConnectResult to a user-facing banner. NOTE: success says "Added" /
// "configured" / "Reconnected", not "Connected" — we verify the config entry
// exists, not that the OAuth token is live. The switch covers the error kinds
// connect can emit; IpcConfigError is a wider union, so this is intentionally
// NOT exhaustive (no strict never-guard) — the default covers kinds other ops
// emit but connect never returns. Shared by AddConnectorModal (Setup) and
// ConnectorInspector (per-connector Reconnect).
export function connectMessage(result: ConnectResult): { tone: 'success' | 'error'; text: string } {
  if (result.ok) {
    if (result.reconnected) {
      return { tone: 'success', text: `Reconnected. "${result.name}" was re-authorized.` };
    }
    return { tone: 'success', text: `Added. "${result.name}" is configured. Restart Claude Desktop to use it.` };
  }
  switch (result.error.kind) {
    case 'login-failed':
      return { tone: 'error', text: 'Authorization failed or timed out. Please try again.' };
    case 'login-invalid-args':
      return { tone: 'error', text: 'Internal error launching the login. Please report this.' };
    case 'name-exists':
      return { tone: 'error', text: 'This connector is already set up.' };
    case 'not-found':
      return {
        tone: 'error',
        text: 'claude_desktop_config.json was not found. Open Claude Desktop and add at least one MCP server first.',
      };
    case 'invalid-name':
      return { tone: 'error', text: result.error.detail };
    case 'invalid-url':
      return { tone: 'error', text: result.error.detail };
    case 'unreadable':
    case 'invalid-json':
    case 'unexpected-shape':
      return { tone: 'error', text: `Could not read the config. ${result.error.detail ?? ''}`.trim() };
    default:
      return { tone: 'error', text: 'An unexpected error occurred.' };
  }
}
