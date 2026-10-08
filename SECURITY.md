# Security Policy

## Supported versions

xCLAUDE Gateway has a single supported release line. Security fixes are made only to the latest published release.

| Version                  | Supported |
| ------------------------ | --------- |
| Latest published release | ✅         |
| Older releases           | ❌         |

## Reporting a vulnerability

Please report suspected security issues **privately**. Do not open a public issue, pull request, or discussion.

Use GitHub's private reporting flow: open the **Security** tab of this repository and click **Report a vulnerability**. This creates a private advisory visible only to the maintainers.

Where possible, include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected xCLAUDE Gateway version and your macOS version.

## What to expect

xCLAUDE Gateway is maintained by a small team. Responses are best-effort, with no guaranteed timeline.

We will acknowledge valid reports and work with you on a fix. If you want credit, we will include it in the release notes.

Please use coordinated disclosure and give us reasonable time to ship a fix before publishing the issue.

## Scope

In scope:

- The gateway itself: the MCP proxy, the `xcg-config` CLI, the Claude Code hook (`xcg-cchook`), the desktop app, and the detection engine.

Out of scope (report these to the respective project instead):

- Third-party or official MCP servers used through xCLAUDE. Report those issues to the server's vendor.
- Claude Desktop. Report those issues to Anthropic.
- Upstream dependencies such as Node, Electron, and libraries. Report those issues upstream.

xCLAUDE Gateway audits MCP traffic and Claude Code tool calls locally. It makes no network calls of its own beyond traffic to the connectors you add and their OAuth sign-in flows. Sign-in pages and links open in your default browser, which makes those connections itself. If you believe a build or update behaves otherwise, please report it.

## Sensitive data in the audit log

The audit log records MCP traffic as it crossed the wire. Oversized values are size-truncated and flagged. This is intentional: the log is designed as a forensic trail.

There are two deliberate exceptions:

- credentials;
- values a user enters in response to an MCP server's elicitation.

If the proxy cannot parse a frame, it records only the frame's size, whatever the frame contains.

### Credentials

Values matched by the `credential_detected` detector (known API-key and token shapes) are masked before they are written. Spent OAuth refresh tokens are also masked before they are written.

The same masking applies to how each server is launched. In launch arguments and HTTP URLs, xCLAUDE masks:

- values of credential-named flags;
- authorization-type headers;
- credential-named `NAME=value` assignments;
- URL userinfo;
- credential-named query parameters;
- any value matching a known credential shape.

In server stderr, xCLAUDE masks values matching a known credential shape.

A masked value is replaced in full with:

```text
[credential:<type> fp:<fingerprint>]
```

The replacement contains the credential type, or where it was found (such as `cli_secret` or `header_secret`), plus a 64-bit HMAC-SHA256 fingerprint keyed with a per-install salt stored at `~/Library/Application Support/xCLAUDE Gateway/audit-salt`. No character of the original value is kept.

The same salt is used for wrapped-MCP and Claude Code records, so the same credential produces the same fingerprint in both, and the fingerprint cannot be checked off your machine without the salt.

If the salt file cannot be read or created, the process uses an ephemeral key instead. The credential is still masked, but its fingerprint will not match fingerprints produced by other processes.

Credential masking is irreversible and cannot be disabled.

### Elicitation

When an MCP server asks the user for input, xCLAUDE does not store what the user enters. This applies to elicitation through wrapped connectors, remote connectors, and Claude Code.

For the server's request, the audit log keeps:

- the mode;
- the message, truncated and with known credential shapes masked;
- for each requested field, its name, type, title, format, and whether it is required.

It does not store default values, options, or descriptions of requested fields. For URL-mode elicitation, it stores the URL without userinfo or fragment, with values of credential-named query parameters masked.

For the user's response, the audit log keeps the action (accept, decline, or cancel) and the mode, never the values entered.

### Everything else

The audit log otherwise contains whatever crossed the wire. This can include:

- a secret in MCP traffic that does not match a known credential shape;
- a secret in launch arguments or stderr that is neither identified by name nor matched by a known credential shape;
- anything a server sends in its own messages. If a server echoes a user's elicitation response back in a tool result, that result is recorded like any other tool result.

Treat the `wrappers/` directory, and any trail you export, as sensitive.

## Config backups

The first time xCLAUDE writes `~/Library/Application Support/Claude/claude_desktop_config.json`, it saves a literal copy of the original next to it as `claude_desktop_config.json.bak`. The copy includes each server's `env`, so it can contain secrets. It is created once and never updated: if you rotate a key, the old value stays in the backup. You can delete it by hand when you no longer need it; the next time xCLAUDE writes the config, it creates a new one from the config as it is then.

Before each change it makes to Claude Code's `~/.claude/settings.json` (installing, updating, or removing its hook), xCLAUDE copies the file's exact contents to `~/Library/Application Support/xCLAUDE Gateway/backups/claude-settings/`, readable only by your user account, and keeps the newest three. The settings file can contain an `env` block, so the copies can contain secrets: a rotated key stays in them until three newer copies replace them. You can delete them by hand; the next change creates a new one.

Versions 1.0.0-beta.4 to 1.0.0-beta.6 instead saved a one-time literal copy as `~/.claude/settings.json.bak`. Later versions neither use nor remove it. It can contain the same secrets, and you can delete it by hand.

## OAuth sign-ins

OAuth tokens for remote connectors are stored in the macOS Keychain, not in xCLAUDE's data folder.

When a connector completes an OAuth sign-in that exchanges an authorization code, the audit log records the authorization server, the resource indicator (canonicalized and redacted like the connector URL), the requested scopes and the granted scopes. It never records OAuth tokens, the authorization code, the `state` value, the PKCE verifier, the client ID, or the callback URL.

A token refresh is not recorded as a sign-in. If the token endpoint rejects a refresh, xCLAUDE records its `error` and `error_description`, truncated, with the spent refresh token masked.

To compare each sign-in with the previous one, xCLAUDE keeps one reference file per connector in `~/Library/Application Support/xCLAUDE Gateway/oauth/v1/`, with file permissions that let only your user account read it. It contains the connector name, the authorization server, the resource, the granted scopes from the most recent sign-in, and when it was written. It contains no token.

## Claude Code hook staging

Claude Code hook events are staged temporarily in `~/Library/Application Support/xCLAUDE Gateway/claude-code/spool/` until the desktop app adds them to the audit log.

Before an event is written to the spool, the hook masks known credential formats, using the same masking logic and per-install salt as the audit log. Detection is based on known formats: a secret that does not match one of them is not masked. If an event cannot be masked, its original content is not stored, only a record that the event was omitted and its size.

When the app adds a staged event to the audit log, an event type without a known storage schema is reduced to the names of its top-level keys.

For MCP elicitation, the hook removes the user's answers (`content`) before anything is written to the spool. It keeps the server, the mode, and the user's action, never the values entered.

Each spool file is deleted after its event has been added to the audit log. If the desktop app is closed, hook events accumulate in the spool until the app runs again.

The hook stops staging new events when less than 2 GB of free disk space remains or more than 50,000 events are waiting. It then counts how many events were skipped; the desktop app records that count in the audit log and shows a notice until it is dismissed.

The app excludes the spool from regular Time Machine backups, and reapplies the exclusion if the spool directory is recreated while the app is running. Local snapshots do not honor that exclusion. We recommend enabling FileVault so that the spool, the audit log, and any snapshots containing them are encrypted at rest.
