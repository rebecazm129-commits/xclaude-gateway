# Architecture

A pnpm monorepo (pnpm 9, Node 22.12 or later, TypeScript; the desktop app is Electron with React). Three workspaces carry the product:

- `packages/proxy` — the MCP proxy (`xcg-proxy`: `stdio` and `http` modes, and the OAuth `login`), the `xcg-config` CLI, the Claude Code hook (`xcg-cchook`) and the detection engine: the detectors, the on-device NER worker, connector surface monitoring and the OAuth sign-in record.
- `packages/shared` — types and utilities shared between the proxy and the desktop app: event types, Claude Desktop and Claude Code config handling, the data-folder path and the word diff used by MCP Changes.
- `apps/desktop` — the Electron app: the **Sources**, **Detections**, **MCP Changes** and **Claude Code** tabs, the menu bar, notifications, and the reader that turns the audit trail into those views.

`packages/detector`, `packages/dashboard` and `packages/orchestrator` are empty placeholders with only a `package.json`.

The app ships the proxy, the CLI and the hook inside its bundle and runs them on its own runtime. `~/Library/Application Support/xCLAUDE Gateway/bin/` holds stable symlinks to `xcg-proxy` and `xcg-cchook`, so a config or hook that points there keeps working when the app is updated.
