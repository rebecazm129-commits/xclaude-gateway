# Manifest attack corpus, v0

A fixed set of manifest changes with their truth recorded **independently of
what the detector does**, so the detector can be measured rather than
described.

Every payload here is synthetic, written for this corpus, CC0-1.0. Nothing is
copied from a published attack collection.

## The three collections

| Directory | What is in it |
|---|---|
| `attack/` | Changes that are malicious and **observable in the manifest** |
| `negatives/` | Legitimate changes that must not be over-alerted |
| `out_of_scope/` | MCP attacks this detector structurally cannot see, each recording which detector could |

## The three states

| `status` | Meaning | What the runner does |
|---|---|---|
| `covered` | The detector catches it at or above `severity.minimum` | Asserts it. A regression fails the build. |
| `gap` | The detector does **not** catch it, and we know | Asserts the **inverse**. A gap that starts passing **fails the build**. |
| `not_observable` | Not this detector's problem | Never executed against the detector |

The inverted assertion on `gap` is the point of the design. An expected-fail
that goes green silently would let the corpus absorb progress without anyone
noticing; here, closing a gap forces an edit to the fixture — `gap` →
`covered` — and that edit is the record of what changed and when.

A `gap` is not a failing test. The suite is green with gaps in it. The summary
line reports them:

```
corpus v0: 14 covered, 25 gaps, 6 not observable, no local negatives
```

## `malicious` vs `status`

`malicious` is the truth of the case. `status` is the detector's behaviour
today. Keeping them apart is what lets a case be honestly uncovered: nothing
turns green because a field was omitted.

## Fixture fields

| Field | Notes |
|---|---|
| `id`, `title` | stable identity, human summary |
| `provenance` | `source` (`synthetic` / `published-research` / `trail-local`), `url`, `licence` |
| `technique` | attack family — **the unit of the dev/holdout split** |
| `observable` | `manifest` / `traffic` / `out_of_band` |
| `mapping` | optional `owasp_mcp`, `mitre_atlas` |
| `baseline`, `changed` | the two manifests to diff |
| `malicious` | ground truth |
| `expected_changes` | finding types a correct detector reports |
| `expected_findings` | finding types that make it a *catch* (attacks) |
| `severity.minimum` | attacks: the floor a catch must reach |
| `severity.maximum` | negatives: the ceiling; `null` means no detection at all |
| `status`, `split`, `notes` | coverage, dev/holdout, and why |
| `would_be_seen_by` | `out_of_scope` only |

## dev / holdout

The split is **by `technique`, not by fixture**. Tuning the detector against
one case would otherwise make its twin in the holdout pass for free, and the
holdout would stop measuring anything. Roughly 60/40 by case count.

Dev families: `prompt_injection_via_description`, `prompt_injection_via_schema`,
`constraint_relaxation`, `sensitive_surface`.
Holdout families: `invisible_characters`, `annotation_tampering`,
`tool_shadowing`.

## Local negatives, never committed

The most valuable negatives are real vendor manifests from the operator's own
trail — and they carry provider tool names, descriptions and schemas tied to a
specific installation. They never live in this repo.

```
XCG_CORPUS_LOCAL=~/Library/Application\ Support/xCLAUDE\ Gateway/corpus-local pnpm test
```

Any `*.json` in that directory holding an array of fixtures joins the run. If
the variable is unset or the directory is missing, the synthetic set runs
alone — which is what CI does. A malformed local file is skipped rather than
failing the repo's suite.

This corpus ships the **mechanism** only; the dump from the trail is a separate
task.
