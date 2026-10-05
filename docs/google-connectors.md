# Google services (Gmail, Google Calendar, Google Drive)

Google's official Workspace MCP servers (Gmail, Calendar, Drive) don't use the one-click flow the other connectors do: Google has no dynamic client registration, so you bring your own (free) OAuth client, and the servers are currently behind Google's Workspace Developer Preview Program. One OAuth client serves all three connectors — and the app walks you through the whole thing. Click **Set up…** on any Google card in **Add source**: a guided 4-step wizard with deep links into the Google Cloud console at every step. Plan for about 10 minutes of clicking, plus an asynchronous wait for Google's approval email.

What the wizard walks you through:

1. **Cloud project + APIs.** Create a Google Cloud project (or pick one you have) and enable the required APIs — one click in the wizard enables all six at once (each service needs its base API and its MCP API; without the `*mcp.googleapis.com` one, that connector's MCP server returns `403` on every tool call). Note the project's **project number** — you'll need it in step 3.
2. **OAuth client.** Configure the consent screen (Internal if available, otherwise External — add your own email under Test users) and create a client with application type **Desktop app**. Google issues a **client ID** and a **client secret**; copy both. (Google's token endpoint requires the client secret even though the flow uses PKCE.)
3. **Preview enrollment.** Enroll your project in the Developer Preview Program with your project number. Approval arrives by email, usually within a couple of days — you can finish step 4 now and connect once it lands. **The one hard requirement:** the enrollment *form* requires an email on a custom domain and rejects plain `@gmail.com` addresses. That is the only place a domain email is needed — the Google account you later connect and audit can be a regular Gmail, and once the project is approved, any Google account can authorize through it. This gate is Google's, and should disappear when these servers leave preview.
4. **Paste your credentials.** The wizard stores your client ID and secret in the macOS Keychain — nothing goes into plain-text config, and no Terminal is involved.

**Finally, connect and restart.** Once seeded, the Google cards show **Connect** instead of **Set up…**. Click it, approve in the browser window that opens (you'll pass Google's "unverified app" screen — see below), then restart Claude Desktop. Google traffic is now audited like any other connector.

## While your client is unverified

Two things to know about running your own client — both are Google's behavior, not xCLAUDE's:

- Google shows a **"Google hasn't verified this app"** screen on each authorization. You continue past it because it's your own client.
- If you clicked **Publish app** on the consent screen (the path the in-app wizard recommends), you authorize once and you're done. If you left the project in testing instead, Google expires the refresh token after 7 days and you **re-authorize about once a week** — xCLAUDE flags a re-login alert on the connector when that happens.

## Scopes

xCLAUDE requests the scopes Google documents for each server.

- **Gmail:** `gmail.modify`. Google's consent screen presents this as "Read, compose, and send emails from your Gmail account" — the permission you grant is broader than what the connector does. Google's Gmail MCP exposes no send tool, so drafting is the most Claude can do through xCLAUDE; the scope also covers moving mail to Trash and marking it as spam — only permanent deletion that bypasses Trash is excluded.
- **Calendar:** `calendar.events` (read and write events), plus `calendar.calendarlist.readonly` and `calendar.events.freebusy`.
- **Drive:** `drive.readonly` + `drive.file` — read, with per-file access.

**Reconnect** requests these same scopes, not every scope the server advertises.
