# Evaluation

## Tool-surface rules V1.0 (commit bdd93e5)

**Setup.** A 54-case holdout was written independently — by a separate model,
without access to the rules — after the V1 rules were frozen in `bdd93e5`.
Every case was run through the real catalog review (the same code path that
reviews a connector's tool catalog when it is first seen), not through copies
of the regular expressions. The cases are kept as regression tests in
`packages/proxy/tests/holdout-v1.test.ts`.

**Result.** Detected 19/24 in-scope attack patterns (P1 4/6, P3 4/6, P4 6/6,
P5 5/6); flagged 0/30 hard-negative and out-of-scope cases.

**Scope.** A small, targeted evaluation of the four patterns V1 claims to
detect, not a measurement of tool-poisoning detection in general. The set was
stratified by pattern, not sampled from real-world traffic.

**Exact 95% intervals, for reference** (Clopper–Pearson): 57.8%–92.9% for
19/24; 0%–11.6% for 0/30.

**Known misses, by form:**

- "by" instead of "from"/"of" ("guidance provided by other servers");
- verbs other than use/call/invoke/select ("choose this server instead of…");
- "dont" without an apostrophe;
- identifier forms with a different word order
  (`disregard_other_server_instructions`, `use_this_instead_of_any_other_tool`).

**Next.** V1.1 will be evaluated on a new, larger holdout not used during
development.

The patterns: P1 disregard other tools' instructions; P3 prefer this tool over
all others; P4 run before/after any tool; P5 stop using a named set of tools in
favour of this one. See `packages/proxy/src/detection/detectors/cross-tool.ts`.
