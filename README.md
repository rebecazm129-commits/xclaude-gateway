<div align="center">

<img src="build/xclaude-icon-dock.png" alt="xCLAUDE Gateway icon" width="128" height="128" />

# xCLAUDE Gateway

**A local audit trail for Claude's tool activity and MCP connector changes.**

[![CI](https://img.shields.io/github/actions/workflow/status/rebecazm129-commits/xclaude-gateway/ci.yml?branch=main&label=CI)](https://github.com/rebecazm129-commits/xclaude-gateway/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rebecazm129-commits/xclaude-gateway?include_prereleases&label=release&color=D86A4D)](https://github.com/rebecazm129-commits/xclaude-gateway/releases)
[![Status](https://img.shields.io/badge/status-beta-E8A33D)](https://github.com/rebecazm129-commits/xclaude-gateway/releases)
[![Platform](https://img.shields.io/badge/macOS-arm64%20(Apple%20Silicon)-000000?logo=apple&logoColor=white)](#installation)
[![License](https://img.shields.io/badge/license-MIT-informational)](#license)

xCLAUDE records and classifies tool activity from Claude Code and wrapped MCP servers — locally on your Mac, in a record you control.

Keep a reviewable history across sessions, spot activity worth a second look, and audit wrapped MCP servers in Claude Desktop too.

No account. No telemetry. Nothing sent to xCLAUDE.

macOS 13+ · Apple Silicon · Open source · MIT

**[Download xCLAUDE](https://github.com/rebecazm129-commits/xclaude-gateway/releases)** · **[xclaude.ai](https://xclaude.ai)**

</div>

<p align="center"><img src="docs/screenshots/detections.png" alt="Detections view: tool calls recorded with their severity, category and source" width="900" /></p>

## Why xCLAUDE?

The more autonomy you give Claude, the harder it becomes to remember exactly what happened across tools, sessions, and clients.

xCLAUDE keeps that activity in one local, reviewable trail: the tool calls Claude makes, what the MCP servers it uses advertise, and how remote connectors sign in. Most activity is ordinary. When something deserves a second look — a credential, PII, a prompt-injection pattern, a data-export or email-send request, or a connector that changes what it advertises or where it signs in — xCLAUDE flags it.

It audits. It doesn't block.

## What it sees

| Surface | Audited? |
| --- | --- |
| Claude Code tool calls | ✅ |
| Wrapped local MCP servers (Claude Code) | ✅ |
| Remote MCP servers connected through xCLAUDE | ✅ |
| Wrapped MCP servers in Claude Desktop | ✅ |
| Claude Desktop native connectors | ❌ |
| Claude Desktop built-in tools | ❌ |
| Conversations / Claude reasoning | ❌ |

If your Claude activity does not pass through one of the audited paths above, xCLAUDE will not see it.

Coverage is not identical on every path:

- **Claude Code tool calls are recorded after each call completes,** so a tool call that never finishes may leave no event.
- **Proxy path only** (wrapped and remote MCP servers): [MCP Changes](#mcp-changes), named-entity PII (`pii_detected`), and `protocol_tripwire`. In Claude Code, the only `protocol_tripwire` recorded is an MCP server asking the user for input (elicitation).
- **Claude Code only:** `audit_trail_modification`.
- The other detectors run on both paths.

xCLAUDE is an audit trail for tool activity, not a transcript of your conversation with Claude.

## Local by design

- **No account, no telemetry, no analytics.** xCLAUDE makes no network calls of its own. The only outbound traffic is to the connectors you add and for their OAuth sign-in flows; links such as "Request a connector" open in your default browser.
- **The logs stay on your Mac,** under `~/Library/Application Support/xCLAUDE Gateway/`. Nothing is deleted by default; automatic purge by age is opt-in.
- **Credentials are masked before they are written,** and what a user enters in response to an MCP server's elicitation is not stored. Other content is recorded as captured, with the exceptions described in SECURITY.md, so treat the audit trail as sensitive.

What is masked, what is kept, and where each piece lives is described in [SECURITY.md](SECURITY.md).

## Installation

**Requirements:** macOS 13 or later on Apple Silicon (arm64 only), and Claude Desktop, Claude Code, or both.

1. Download the latest `.dmg` from the [latest GitHub release](https://github.com/rebecazm129-commits/xclaude-gateway/releases/latest).
2. Open the `.dmg`, drag `xCLAUDE Gateway.app` into `/Applications/`, eject the disk image, and launch the app **from Applications**. The app is signed with a Developer ID and notarized by Apple.
3. In the **Sources** tab:
   - **Claude Desktop's local MCP servers:** the tab lists every entry in your `claude_desktop_config.json` as **Auditing**, **Not audited**, or **Unsupported**. Open **Settings** (the gear icon) and click **Install** to wrap the eligible ones. On the first install, xCLAUDE keeps a one-time backup at `~/Library/Application Support/Claude/claude_desktop_config.json.bak`.
   - **Claude Code:** click **+ Add source** and **Install hook** on the Claude Code card.
   - **Remote services:** click **+ Add source** and connect one (see [docs/remote-connectors.md](docs/remote-connectors.md)).
4. Restart Claude Desktop after wrapping a server or connecting a service.

Optional: the **Verify detection** button in Sources runs a synthetic risky payload through the pipeline and confirms that it is flagged.

To edit the config by hand instead, see [docs/manual-configuration.md](docs/manual-configuration.md).

## Detections

The **Detections** tab lists every recorded tool call. **Claude Code** shows the same record grouped by session and project.

| Category | Severity | What it flags |
| --- | --- | --- |
| `credential_detected` | CRITICAL | Known formats of API keys and tokens. |
| `prompt_injection` | CRITICAL | Instruction-override, role-override, system-prompt-extraction, and jailbreak phrasing. |
| `email_send_warning` | HIGH / MEDIUM | Requests to send email, in tool arguments or results, and send (HIGH) or draft (MEDIUM) email tools. |
| `audit_trail_modification` | HIGH | A Claude Code tool call that writes to or deletes xCLAUDE's own data folder. |
| `protocol_tripwire` | HIGH / MEDIUM / LOW | A server sending the client a request other than ping or roots, an unknown method or protocol version, or an `input_required` response. |
| `data_export_warning` | MEDIUM | Requests to export data; in tool results, only when they name an explicit destination. |
| `pii_structured` | MEDIUM | Well-formed PII shapes, checksum-confirmed where the format has a checksum. |
| `pii_detected` | LOW | People, organizations, and locations found by the on-device NER model. |
| `tool_call_allowed` | NONE | Normal activity: a call that matched none of the above. |

- **NONE is normal activity.** It counts toward **Total** and toward no severity. **Flagged only** (off by default) narrows the list to calls matched by a detector.
- **SOURCE** identifies where a call came from: a connector (Notion, Google Drive…), a wrapped server's own name, or Claude Code. In the Claude Code view, an MCP tool shows as the tool alone, with its connector shown as "via Notion".
- **Export** the filtered list as JSONL (the record exactly as written) or CSV (severity empty for normal activity).

Rules, PII shapes, and the detector chain are described in [docs/detections.md](docs/detections.md).

## MCP Changes

<p align="center"><img src="docs/screenshots/mcp-changes.png" alt="MCP Changes: changes to a connector's surface and sign-ins, with review status" width="900" /></p>

**MCP Changes** tracks what a connector advertises and how its sign-ins change over time. It works on the proxy path.

**Connector surface.** xCLAUDE keeps a reference snapshot of what each server advertises — `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, and server discovery — and records one row per comparison, regardless of how many items changed.

- The **change** itself (a description, an input schema, an added or removed item) carries no severity.
- **Findings** come from rules: a sensitive parameter being added, a reference to a credential file path, instruction-shaped text (including phrasing aimed at other tools), and invisible characters. Each finding carries its rule's ID and version.
- **Review recommended** is a heuristic for text added to an existing description on a single tool, even when no rule matches.
- **Tool catalog review.** The first tool catalog a connector shows is reviewed for instruction-shaped text, credential file paths, and invisible characters. Each stored tool catalog is reviewed once more when one of those rules is updated. A clean review is silent. A review with findings appears as "Existing tool definition flagged". These are specific patterns, not a detector for tool poisoning in general. See [EVALUATION.md](EVALUATION.md).

**Authorization.** Each OAuth sign-in that exchanges an authorization code records the authorization server, the resource, and the granted permissions. It is compared with the previous sign-in. A different authorization server is flagged HIGH, while expanded permissions are flagged MEDIUM. Both trigger a macOS notification. Reduced permissions and a different resource are recorded without a severity.

**Reviewing.** The tab opens on **Needs review only**: changes with a finding or review recommendation that have not been marked as reviewed. A change with no finding shows NONE. It does not count toward the severity cards, menu bar, or connector card. The panel highlights inserted text and opens the full before/after diff. Rows can be marked as reviewed and exported as a versioned JSON document. Changes recorded before this format existed appear under the **Previous format** status option. The menu bar shows how many changes rated MEDIUM or above from the last 24 hours are waiting for review.

## How xCLAUDE audits Claude

<p align="center"><img src="docs/screenshots/claude-code.png" alt="Claude Code view with session activity and an open detection showing the tool call, its arguments and the detection result" width="900" /></p>

xCLAUDE audits Claude through three paths. None of them changes the servers themselves:

- **Claude Code, through hooks.** A hook in `~/.claude/settings.json` reports each tool call after it runs, along with session starts and ends and MCP elicitations. Events are staged locally and added to the audit trail by the app. See [docs/claude-code.md](docs/claude-code.md).
- **Local MCP servers, through the proxy.** A wrapped server is launched by `xcg-proxy`, which records every JSON-RPC frame in both directions, the server's stderr, and what it advertises. xCLAUDE does not modify tool calls or their results.
- **Remote MCP servers, through the proxy.** For a service connected in xCLAUDE, the proxy is Claude Desktop's connection to it. OAuth tokens are stored in the macOS Keychain. See [docs/remote-connectors.md](docs/remote-connectors.md) and [docs/google-connectors.md](docs/google-connectors.md).

Detection runs on all three paths, with the path-specific differences described in **What it sees** above. Credential masking also runs on all three paths, using the same per-install salt, so the same credential has the same fingerprint wherever it appears. How the trail is stored, verified, and retained is described in [docs/audit-trail.md](docs/audit-trail.md).

### Wrapping Claude Code's MCP servers

Claude Code's hooks already record MCP tool calls. Wrapping a local stdio server adds what only the protocol level can show: what it advertises, its stderr, and server-initiated requests. Set it up with `claude mcp add-json`, as described in [docs/claude-code.md](docs/claude-code.md#wrapping-claude-codes-mcp-servers).

## Known limitations

xCLAUDE is a complement to the safety behavior of your MCP client, not a replacement for it.

- **It never blocks or alters a tool call.** Claude often refuses a sensitive operation before any tool call is made. If no tool call is made, xCLAUDE has nothing to record.
- **Detections sit on top of the audit trail; the underlying record remains available for later review.**
- **Claude Code tool calls are recorded after they complete.** A call that never finishes may leave no event. Elicitations and session starts and ends are recorded when they happen.
- **Tool catalog review covers specific patterns.** It does not catch a reference to a specific tool of another server, poisoning with no instruction-shaped wording, or an instruction split across several tools or fields.
- **Some text patterns are English only.** Injection and tool catalog phrasing is matched in English; email and data-export phrasing is matched in English and Spanish.
- **Claude Desktop's native Connectors cannot be audited.** Their traffic goes through Anthropic's servers and never reaches your machine. Connect the same service *through* xCLAUDE instead.
- **Durability is not transactional.** Writes are append-only but not fsynced per line.
- **Out of scope today:** Cowork, direct Anthropic API use, the content of Skills (their tool calls are captured), and Claude's built-in tools such as web search or code execution.

## Advanced documentation

| Topic | Document |
| --- | --- |
| Claude Code hooks, elicitation, profiles, wrapping Claude Code's servers | [docs/claude-code.md](docs/claude-code.md) |
| Connecting remote services, sign-ins, re-login alerts | [docs/remote-connectors.md](docs/remote-connectors.md) |
| Gmail, Google Calendar and Google Drive setup | [docs/google-connectors.md](docs/google-connectors.md) |
| Detectors, PII shapes, protocol tripwires | [docs/detections.md](docs/detections.md) |
| Storage, verification, retention | [docs/audit-trail.md](docs/audit-trail.md) |
| Wrapping servers by hand | [docs/manual-configuration.md](docs/manual-configuration.md) |
| Common issues | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Repository layout | [docs/architecture.md](docs/architecture.md) |
| What is masked and kept, reporting a vulnerability | [SECURITY.md](SECURITY.md) |
| How the tool catalog rules were measured | [EVALUATION.md](EVALUATION.md) |

## Uninstall

1. In xCLAUDE, open **Settings** and click **Uninstall** to revert the wrapped servers in your Claude Desktop config. To remove the Claude Code hook, open the Claude Code source in **Sources** and click **Uninstall**.
2. Move `xCLAUDE Gateway.app` from `/Applications/` to the Trash.
3. Optionally delete the audit trail and settings:

```bash
rm -rf ~/Library/Application\ Support/xCLAUDE\ Gateway/
```

## Disclaimer

xCLAUDE Gateway is an independent, open-source project, not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Desktop" are trademarks of Anthropic. Other product names and logos — Google, Gmail, Slack, Notion, and the like — belong to their respective owners and are used for identification only.

## License

MIT. © Rebeca Zambrano Moreno & Ignacio Lucea Artero.
