# CLAUDE.md

Instructions for Claude Code sessions in this repository.

## Protocol rules (non-negotiable)

- **Never commit or push without Rebeca's explicit OK in the current turn.**
  A dictate that says "NO commit" is not voided by green tests, a passed
  review, or a phase description that mentions a commit later — the OK must
  be given in the turn where the commit happens.
- **`git add` only with explicit paths; `-A` is forbidden.** Before every
  commit: show `git status`, confirm the staged set matches the commit
  message, and flag any leftovers from other work instead of adding them.
- **Notarization only with Rebeca's explicit OK.**
- **If a verification fails, propose the fix and wait for the OK before
  applying it.** This applies to every fix, including one-line test
  adjustments.
