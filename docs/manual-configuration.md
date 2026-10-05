# Manual configuration

How to wrap MCP servers by editing Claude Desktop's config yourself instead of using the app's **Install** action.

If you prefer to edit your config by hand instead of clicking **Install** in the app, back up your config first:

```bash
cp ~/Library/Application\ Support/Claude/claude_desktop_config.json \
   ~/Library/Application\ Support/Claude/claude_desktop_config.json.bak
```

For each MCP server you want to wrap, replace its entry with one that points to the stable proxy launcher and passes the original command as arguments.

Before (example with `@modelcontextprotocol/server-filesystem`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

After (wrapped through xCLAUDE Gateway):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "/Users/<you>/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy",
      "args": [
        "--wrap", "/usr/local/bin/npx",
        "--name", "filesystem",
        "--",
        "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"
      ]
    }
  }
}
```

The path under `~/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy` is a stable symlink created by the `.app` on first launch; it resurfaces correctly after the `.app` is replaced by an updated version. Arguments after `--` are passed verbatim to the wrapped server. Use `--name` to set a label that identifies this MCP in the logs and in the app.

For a remote MCP server, the wrapped entry uses the `http` subcommand instead, with the service URL passed as an argument:

```json
{
  "mcpServers": {
    "notion": {
      "command": "/Users/<you>/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy",
      "args": ["http", "--url", "https://mcp.notion.com/mcp", "--name", "notion"]
    }
  }
}
```

The same pattern applies to other remote connectors — for example Linear, with `"--url", "https://mcp.linear.app/mcp", "--name", "linear"`.

You must run the OAuth login once before this works — connecting the service from **+ Add source** in **Sources** does this for you. Restart Claude Desktop after editing.

## Reverting by hand

The first time you click **Install**, xCLAUDE keeps a one-time backup of your original config at `~/Library/Application Support/Claude/claude_desktop_config.json.bak`, which later operations never overwrite. To restore it without the app:

```bash
mv ~/Library/Application\ Support/Claude/claude_desktop_config.json.bak \
   ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Restart Claude Desktop afterwards.
