# Troubleshooting

**Claude Desktop shows "MCP server failed to start" for a wrapped MCP.** Check the `command` path in your config matches the actual launcher path. Make sure the `.app` is in `/Applications/` and that you opened it once (which creates the stable symlink).

**No JSONL files appear in the wrappers directory.** Verify the proxy is running with `ps aux`. Make sure Claude Desktop was restarted after editing the config; the config is only read on Claude Desktop startup.

**A "Server disconnected" banner appears when I quit Claude Desktop.** Expected. The wrapper closes cleanly and Claude Desktop reports that the MCP is no longer reachable. Dismiss the banner.

**The Detections tab shows no events but the JSONL has them.** The app re-reads the trail every two seconds. Check that no filter, time range or **Flagged only** is narrowing the list; if events still don't appear, restart `xCLAUDE Gateway.app`.

**The app looks outdated after an update (old icon, missing connectors).** Make sure you're not running the copy inside a mounted `.dmg`: eject any "xCLAUDE Gateway" disk image and launch from `/Applications/`.

**Claude Code activity doesn't appear.** Check the Claude Code source in **Sources**: the hook must be installed, and a pending **Update hooks** may be needed for newer events. Claude Code events wait in the spool while the app is closed and are added when it runs again. If you use a Claude Code profile outside `~/.claude`, see [claude-code.md](claude-code.md#other-claude-code-profiles).

**A connector shows a re-login alert.** Its authorization expired or was revoked. Click **Reconnect** in the connector's inspector, approve in the browser, and restart Claude Desktop. See [remote-connectors.md](remote-connectors.md#re-login-alerts).
