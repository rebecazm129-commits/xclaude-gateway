# config-cc fixtures

Real Claude Code **v2.1.214** project-config captures (2026-07-18), taken
during spike 3 of F2.1.0 (`~/spikes/xcg-spike3`) on the maintainer's machine.
Each file is byte-for-byte as written by Claude Code — do not reformat or
pretty-print.

- `mcp.json.paso3` — `.mcp.json` right after
  `claude mcp add --scope project toy-stdio -- node <abs path>`: stdio entry
  with explicit `"type": "stdio"`, `command` + `args` (paths expanded to
  absolute), and `env: {}` present even though empty.
- `mcp.json.paso4` — after also adding
  `claude mcp add --transport http --scope project toy-http <url>`: the http
  entry is minimal (`type` + `url` only), appended after the existing one.
- `settings.local.json.paso6` — `.claude/settings.local.json` after APPROVING
  both servers in the session-start dialog: ONLY `enabledMcpjsonServers` is
  written.
- `settings.local.json.pasoB-rechazo` — after REJECTING all with Esc: ONLY
  `disabledMcpjsonServers`. The two keys are never written together with one
  empty; with no decision yet the file does not exist at all.

Note the trailing bytes: the `.mcp.json` captures end without a newline,
the `settings.local.json` captures end with one. Both are the originals.

Sanitization applied: the local username was replaced with `user` everywhere
it appeared (paths). **Nothing else was altered** — key order, indentation
and trailing bytes are the originals.

Policy for contributors: new fixtures MUST be sanitized the same way
(username → `user`, nothing else touched). The sanitization is an executable
invariant: `tests/config-cc/parser.test.ts` has a guard test that fails on
any `/Users/...` path whose first segment is not `user`.
