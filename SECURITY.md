# Security Policy

## Supported versions

xCLAUDE Gateway ships as a single line of releases. Only the latest published release receives security fixes.

| Version                  | Supported |
| ------------------------ | --------- |
| Latest published release | ✅         |
| Older releases           | ❌         |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue, pull request, or discussion for a suspected vulnerability.

Use GitHub's private reporting: open the **Security** tab of this repository and click **Report a vulnerability**. This creates a private advisory visible only to the maintainers. If you prefer email, write to **hello@xclaude.ai**.

Where possible, include:
- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected version and your macOS version.

## What to expect

xCLAUDE Gateway is maintained by a small team, so responses are best-effort with no guaranteed timeline. We will acknowledge valid reports, work with you on a fix, and credit you in the release notes if you wish. We ask for coordinated disclosure: please give us reasonable time to ship a fix before disclosing publicly.

## Scope

In scope:
- The gateway itself: the MCP proxy, the `xcg-config` CLI, the desktop app, and the detection engine.

Out of scope (report to the respective project instead):
- Third-party or official MCP servers you connect through xCLAUDE — report to their vendor.
- Claude Desktop — report to Anthropic.
- Upstream dependencies (Node, Electron, libraries) — report upstream.

xCLAUDE Gateway audits MCP traffic locally and makes no network calls of its own. If you believe a build or update behaves otherwise, that is exactly the kind of report we want.

## Sensitive data in the audit log

The audit log records MCP traffic as it crossed the wire (oversized values are size-truncated and flagged) — that is the point of a forensic trail. The one deliberate exception is credentials: values matched by the `credential_detected` detector (API-key and token shapes) are masked before they are written, replaced by a 10-character prefix plus an irreversible HMAC-SHA256 fingerprint keyed by a per-install salt (`~/Library/Application Support/xCLAUDE Gateway/audit-salt`). The same salt keys both the wrapped-MCP and Claude Code paths, so a credential fingerprints identically across sources while remaining unverifiable off your machine. The masking is irreversible and has no toggle.

The log otherwise contains whatever crossed the wire, including any secret that does *not* match a known credential shape. Treat the `wrappers/` directory — and any trail you export — as sensitive.
