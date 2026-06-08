// Shared formatters for config IPC results, used by both the Connectors view
// (error panel) and the Settings drawer (install/uninstall feedback). Pure,
// no state, no node imports — safe for the renderer.

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
