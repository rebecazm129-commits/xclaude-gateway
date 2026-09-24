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
| `status`, `split`, `notes` | coverage, dev/holdout (see the split rule below), and why |
| `would_be_seen_by` | `out_of_scope` only |

## dev / holdout

The split is **by VARIANT within a family**, not by family and not at random.

Two things have to be true at once. A family must be **workable**: if every
variant of `invisible_characters` sat in the holdout, touching that family at
all would mean opening it. And a family must stay **measurable**: if tuning
against one variant made its siblings pass for free, the holdout would measure
nothing.

Variants of the same family exercise *different mechanisms*, which is what
makes the split meaningful. Zero-width padding and a bidi override are both
"invisible characters", but one pads a string and the other lies about reading
order — closing the first does not close the second. So one or two variants of
each family sit in dev and the rest are held out:

| Family | dev | holdout |
|---|---|---|
| `invisible_characters` | zero-width, ANSI | variation selectors, soft hyphen / U+180E, Cyrillic homoglyphs |
| `annotation_tampering` | `readOnlyHint` | `destructiveHint` |
| `tool_shadowing` | exact name | paraphrase |

### The first `invisible_characters` holdout was burned

Its original holdout was bidi override, tag characters and the HTML comment.
All three are now `covered` — and that number means **nothing as a measure of
generalisation**, because the class list in `text-normalize.ts` was written
with those exact ranges in front of it. `U+202A-U+202E` and
`U+E0000-U+E007F` are in the detector because those cases were on screen. A
holdout you can read while writing the rule is a dev set with extra steps.

They stay in the corpus as regression tests, which is what they are honestly
good for. The holdout was replaced with three variants written afterwards,
each probing a mechanism the four implemented classes do not cover:

| Variant | Why it is not a rerun of the burned set |
|---|---|
| variation selectors (`U+FE00-FE0F`, `U+E0100-E01EF`) | a fifth invisible class — tests whether the rule generalises past its enumerated ranges |
| soft hyphen `U+00AD` + `U+180E` **inside** a path and a keyword | not hiding text but BREAKING a string, so the path rule and the injection pattern see something that is not there |
| Cyrillic homoglyphs (`ignоre`) | nothing is invisible at all: every character renders, NFKC does not fold scripts, and a Latin pattern cannot match |

All three measured `medium` / `description_changed` on the day they were
written: three fresh gaps. That is the number worth tracking.

**Known imbalance.** `prompt_injection_via_description`,
`prompt_injection_via_schema`, `constraint_relaxation` and `sensitive_surface`
are currently all-dev. They were written before this rule and have not been
re-split; doing so would hold out cases the detector already covers, which
measures nothing useful today. They should be split the same way when new
variants are added to them.

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
