# cchook fixtures

Real Claude Code **v2.1.210** hook payload captures (2026-07-15), taken during
the xcg-cchook spike on the maintainer's machine. Each file is ONE raw JSON
line, byte-for-byte as emitted by the hook — do not reformat or pretty-print.

Sanitization applied: the local username was replaced with `user` everywhere it
appeared (paths, `transcript_path`, `cwd`, commands, and the owner columns
inside fixture 11's `ls` stdout). **Nothing else was altered** — UUIDs,
`toolu_*` ids, model, dates, locale and `ls` metadata are the originals.

Policy for contributors: new fixtures MUST be sanitized the same way (username
→ `user`, nothing else touched). The sanitization is an executable invariant:
`tests/cchook-ingest.test.ts` has a guard test that fails on any `/Users/...`
path whose first segment is not `user`.
