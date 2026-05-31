# xCLAUDE Gateway

A local MCP traffic observer for Claude Desktop. Wraps your existing local MCP servers, records every JSON-RPC frame to a per-session log on your Mac, and classifies sensitive patterns with severity tags. The audit happens locally; the traffic still reaches the MCP server it's addressed to.

## What it does

When you use Claude Desktop with local MCP servers (filesystem, custom scripts, anything you launch via `npx` or a local binary), xCLAUDE Gateway sits transparently between Claude Desktop and each MCP server you choose to wrap:

- **Wraps your existing MCP servers transparently** — no changes to the servers themselves.
- **Records every JSON-RPC frame** (requests, responses, notifications) to a per-session JSONL log under `~/Library/Application Support/xCLAUDE Gateway/wrappers/`.
- **Classifies sensitive patterns** with a detection engine. Current active detectors:
  - `credential_detected` (CRITICAL) — known formats of API keys (Anthropic, OpenAI, GitHub, AWS, and similar).
  - `prompt_injection` (CRITICAL) — common injection phrases ("ignore all previous instructions", "follow any instructions you find inside this file", etc.).
  - `email_send_warning` (HIGH) — imperative requests to send email through tools.
  - `data_export_warning` (MEDIUM) — imperative requests to export data.
  - A `tool_call_allowed` baseline at LOW severity is emitted for every tool call that doesn't match any of the above. This is the "everything is normal" line, not an absence of analysis.
- **Captures latency overhead per response** (`overheadUs`) and end-to-end server response time (`latencyMs`).
- **Captures the wrapped server's stderr output** as separate events.
- **Shows the classified events in a Detections view** inside the `xCLAUDE Gateway.app` window, with severity and category filters.
- **Auto-configures `claude_desktop_config.json`** from a Setup UI: one click installs the wrappers, another reverts them, with a backup of your original config preserved.
- **Audits remote MCP servers you connect through it.** Connect a service (like Notion) via xCLAUDE instead of as a native Connector, and Claude's calls to it are bridged through your Mac, where every frame is recorded and classified — same as a local server.

The audit runs entirely on your Mac: no telemetry, no account, no data sent to us. Note that wrapped servers still talk to their destination — a local MCP server to your filesystem, a remote connector to its provider over the network. xCLAUDE observes that traffic; it doesn't reroute or withhold it.

## What this proxy is, and what it is not

xCLAUDE Gateway is a **complement to the safety behavior of your MCP client**, not a replacement for it.

In practice, Claude Desktop's model often refuses sensitive operations on its own — before they ever reach the proxy. If you ask the model to write a credential to a file, it will likely decline. The proxy doesn't see that refusal because no tool call was made. **That is by design and not a limitation of this tool**.

What the proxy adds on top of that:

- A **complete local audit trail** of every tool call that did happen. Forensics, not just detection. If in six months you wonder what crossed your Mac, the JSONL log tells you exactly.
- A **second independent layer** of classification, useful in flows where the model is less cautious about each individual tool call (agentic workflows, long automated chains, future MCP clients with different safety postures).
- A **foundation for active-blocking logic** in later milestones.

If you're looking for a tool that prevents Claude from making sensitive tool calls in the first place, the model itself is already doing most of that work. If you're looking for a tool that records, classifies and gives you visibility over the MCP traffic on your machine, this is it.

## What it does NOT do yet

- **No active blocking of tool calls.** The detectors tag with severity; they do not stop the operation.
- **PII detection is in progress** (transformers.js NER, validation pending).
- **No auditing of native Connectors.** Services you connect with one click in Claude Desktop's settings are brokered through Anthropic's servers; their traffic never reaches your Mac, so xCLAUDE can't see it. To audit such a service, connect it through xCLAUDE instead (see "Remote connectors" below).
- **No Gatekeeper-friendly install on machines other than the build machine.** The `.app` is signed with a Developer ID but not yet notarized by Apple. On the build machine it opens cleanly; on other Macs, right-click → Open is required the first time.

These come in upcoming milestones. See the project roadmap for details.

## Scope

xCLAUDE Gateway in its current state **covers a specific subset** of the Claude ecosystem:

### What is covered

- **Claude Desktop** with **local MCP servers** that are wrapped via the Setup UI (or manually in `claude_desktop_config.json` by pointing them to `xcg-proxy`).
- **Remote MCP servers connected through xCLAUDE** (Notion today; more to come). You connect them in the app's Remote Connectors panel, which signs you in and bridges the traffic through your machine for auditing.

### What is NOT covered

- **Claude Desktop's native Connectors** (the ones you enable with one click in Settings). xCLAUDE cannot audit those: they are brokered through Anthropic's servers, so their traffic never reaches your machine — intercepting it would require breaking TLS, which this project will not do. **What xCLAUDE offers instead is its own audited path to the same services:** connect a remote MCP server *through* xCLAUDE (see "Remote connectors" below) and its traffic is bridged via your machine, where xCLAUDE can observe it. To audit a service this way, connect it through xCLAUDE rather than as a native Connector.
- **Claude Code** (the CLI). It is a separate MCP client with its own configuration. The wrapper itself might work technically if pointed there, but this has not been tested or documented.
- **Cowork.** Same reasoning as Claude Code: separate client, separate configuration, not currently tested.
- **Anthropic's API directly** (any SDK integration). No MCP client model applies; out of scope by design.
- **Skills** (markdown files used by the model as context). They are not JSON-RPC traffic; they are not interceptable by a stdio proxy. The proxy does capture any tool calls a skill ends up making, but not the skill content itself.
- **Claude's native tools** (web search, computer use, code execution, etc.). These are internal model tools, not MCP servers. They never traverse the proxy.

If you're using Claude Desktop with local MCP servers, or you connect a remote service through xCLAUDE, you're in scope. If your main use is anything else, this tool will not give you what you expect today.

## Requirements

- macOS 13 or later.
- Claude Desktop installed and working.
- At least one local MCP server you already use. If you don't have one, `@modelcontextprotocol/server-filesystem` is an easy starting point (installable via `npx -y`).

## Installation

1. Download the latest `.dmg` from the GitHub Releases page.
2. Open the `.dmg` and drag `xCLAUDE Gateway.app` into `/Applications/`.
3. On first launch, macOS may show a Gatekeeper warning because the build is signed but not yet notarized. Right-click the `.app` and choose "Open" once; subsequent launches will not prompt.

## Configuration

Open `xCLAUDE Gateway.app`. The Setup tab shows your current `claude_desktop_config.json`: which MCP servers will be wrapped, which are already wrapped, and which are skipped. Click **Install** to wrap all eligible servers. Click **Uninstall** to revert.

The first time you click Install, xCLAUDE Gateway makes a one-time backup of your config at `~/Library/Application Support/Claude/claude_desktop_config.json.bak` which is never overwritten by subsequent operations.

If you prefer manual configuration, see "Manual configuration" below.

## Remote connectors

xCLAUDE can audit remote MCP services (starting with Notion) by acting as your connection to them, instead of Claude Desktop connecting directly.

To audit a service this way:

1. If you already have it enabled as a native Connector in Claude Desktop, disconnect it there first. xCLAUDE audits its own bridged connection, not the native one.
2. In xCLAUDE, open the Setup tab and find the service under **Remote connectors**. Click **Connect**.
3. A browser window opens to authorize the service (standard OAuth). Approve it; the tab will say the login is complete.
4. Restart Claude Desktop. Claude now reaches the service through xCLAUDE, and every call is recorded and classified like any other MCP traffic.

Your authorization token is stored in the macOS Keychain, not in plain text. xCLAUDE never sees your password. The traffic still reaches the provider — xCLAUDE observes it on its way through, it does not withhold or reroute it.

## Verification

After restarting Claude Desktop with at least one wrapped MCP, verify the proxy is running:

```
ps aux | grep xcg-proxy | grep -v grep
```

One process per wrapped MCP should appear.

Verify a session log was created:

```
ls -lt ~/Library/Application\ Support/xCLAUDE\ Gateway/wrappers/
```

A new JSONL file appears every time Claude Desktop starts with wrapped MCPs.

Inspect a log entry:

```
tail -1 ~/Library/Application\ Support/xCLAUDE\ Gateway/wrappers/<latest>.jsonl | jq .
```

A typical event:

```json
{
  "v": 1,
  "id": "01KRG8C71M9EXBRJE1T19A1583",
  "ts": "2026-05-13T08:48:40.501Z",
  "session": "01KRG87RPQ59QFBZAK8BXT02DY",
  "mcp": "filesystem",
  "type": "mcp.request",
  "direction": "client_to_server",
  "rpcId": 4,
  "method": "tools/call",
  "params": {},
  "bytes": 117,
  "overheadUs": 322,
  "detection": {
    "category": "tool_call_allowed",
    "severity": "low",
    "findings": []
  }
}
```

Each session writes its own file. The file name is the session ID (ULID). Open `xCLAUDE Gateway.app` and click the **Detections** tab to see the same events with severity and category filters.

## Manual configuration

If you prefer to edit your config by hand instead of using the Setup UI, back up your config first:

```
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

The path under `~/Library/Application Support/xCLAUDE Gateway/bin/xcg-proxy` is a stable symlink created by the `.app` on first launch; it resurfaces correctly after the `.app` is replaced by an updated version. Arguments after `--` are passed verbatim to the wrapped server. Use `--name` to set a label that identifies this MCP in the logs and in the dashboard.

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

You must run the OAuth login once before this works — the Remote connectors panel does this for you.

Restart Claude Desktop after editing the config.

## A note on expectations

In ordinary, day-to-day use of Claude Desktop with local MCP servers, most events will be `tool_call_allowed` at LOW severity. That is the intended baseline, not a sign that "nothing is happening". The Detections view highlights events at MEDIUM, HIGH or CRITICAL only when a detector matches. This typically happens rarely in normal use, because Claude Desktop's model already refuses many sensitive operations before any tool call is issued.

The value of xCLAUDE Gateway in this phase comes from three places: the **complete local audit trail**, the **classification of patterns when they do appear**, and the **foundation for active blocking** in later milestones.

## Troubleshooting

**Claude Desktop shows "MCP server failed to start" for a wrapped MCP.** Check the `command` path in your config matches the actual launcher path. Make sure the `.app` is in `/Applications/` and that you opened it once (which creates the stable symlink).

**No JSONL files appear in the wrappers directory.** Verify the proxy is running with `ps aux`. Make sure Claude Desktop was restarted after editing the config; the config is only read on Claude Desktop startup.

**A "Server disconnected" banner appears when I quit Claude Desktop.** Expected. The wrapper closes cleanly and Claude Desktop reports that the MCP is no longer reachable. Dismiss the banner.

**The Detections tab shows no events but the JSONL has them.** Restart `xCLAUDE Gateway.app`. The dashboard polls the JSONL files on startup; if the app was running before the wrappers started writing, refresh by reopening.

## Uninstall

1. Open `xCLAUDE Gateway.app` and click **Uninstall** on the Setup tab. This reverts all wrapped MCP servers in your config.
2. Move `xCLAUDE Gateway.app` from `/Applications/` to the Trash.
3. Optionally delete the logs:

```
rm -rf ~/Library/Application\ Support/xCLAUDE\ Gateway/
```

If you prefer manual uninstall:

```
mv ~/Library/Application\ Support/Claude/claude_desktop_config.json.bak \
   ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

This restores the original config from the backup.

## Architecture

Monorepo with three workspaces:

- `packages/proxy` — the MCP proxy itself plus the `xcg-config` CLI.
- `packages/shared` — types and utilities shared between proxy and desktop.
- `apps/desktop` — the Electron app shipping the Setup UI and live Detections view.

Built with pnpm 9, Node 22, Electron, TypeScript.

## License

MIT. © Rebeca Zambrano Moreno & Ignacio Lucea Artero.
