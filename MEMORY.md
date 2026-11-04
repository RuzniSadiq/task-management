# MEMORY.md — shared agent memory

**Read this early** in any coding, review, or merge session.
**Update it** when the same failure class appears twice (prefer a test/sensor over a long essay).

Keep this file short so every agent loads it. Expand long-form detail in optional
files under `memory/` if the index grows.

### Dual-write rule (mandatory)

Whenever an agent writes durable operational memory in a local runtime store,
**also write here** so other agents and machines share the same context.

### No CI loop for memory-only updates

Commits that touch **only** this file (and optional pure memory paths named in
`AGENTS.md`) do **not** require typecheck, lint, test, build, product PRs, or
required CI. Land the lesson on the default branch quickly.

Mixed memory + product code still uses the normal green gate.

Canonical convention: The Gibson `docs/24-agent-memory-conventions.md`
(copy at adoption; this file is owned by **this** repo thereafter).

_Last updated: 2026-11-03_

---

## Operating notes

| Topic | Rule |
|-------|------|
| Claims | `- Active-work claim: <slug>` line in an open PR body |
| Green gate | See `AGENTS.md` / `.agents/gate.json` |
| Deploy | not deployed |

---

## Lessons (append-only)

### How to add a lesson

1. `git fetch && git rebase origin/main` (or equivalent).
2. Append a new dated section at the **bottom** — do not rewrite history.
3. Commit **only** memory files; skip the product CI loop.
4. Never put secrets, tokens, or Production connection strings here.

```markdown
## YYYY-MM-DD — <short-slug>

- **What happened:** …
- **Root cause:** …
- **Fix / rule:** …
- **Links:** issue/PR if any
```

---

## 2026-11-03 — adoption-seed

- Repo adopted Gibson agent-memory conventions (AGENTS memory block + this file).
- Pure memory commits skip the product green gate; dual-write is mandatory.

## 2026-11-04 — claim-id-must-be-canonical

- **What happened:** On PR #15 (issue #14), `release-claim.sh` refused to clean up (exit 1, nothing changed). The PR body had `- Active-work claim: readme-project-status`, with no `Issue:` or `Claim scope:` line.
- **Root cause:** This repo's `AGENTS.md` (copied from the Gibson template `AGENTS-section.md`) says the claim line is `- Active-work claim: <slug>`. Gibson's `release-claim.sh` only matches ids shaped `issue-<N>-<slug>`, the shape `claim.sh` writes along with `- Issue: #N` and `- Claim scope: …`. The builder wrote the line by hand from the doc and did not run `claim.sh`.
- **Fix / rule:** Claim with Gibson's `scripts/claim.sh`. If you write the block by hand, the id must be `issue-<N>-<slug>` (for example `issue-14-readme-project-status`), with `- Issue: #N` and `- Claim scope: <paths>` lines. Follow-up: fix the `<slug>` wording here and in the Gibson template (a harness issue, which needs a human because the agent token covers this repo only).
- **Links:** PR #15, issue #14

## 2026-11-04 — write-loop-state-before-long-work

- **What happened:** Four security-hat runs on PR #15 in a row (01:26, 01:41, 01:59, 03:00 UTC) ended with exit 124 (timeout) before rewriting `gibson/loop-state.md`. The driver marked each one `state-corrupt` (stale `updated`), and the hat repeated until a fifth run finished.
- **Root cause:** The hat rewrote state only at the very end. A run that hit the driver's timeout left nothing behind, so the next run started over.
- **Fix / rule:** Rewrite loop-state with a fresh `updated` and the current `next_action` early in the hat, then again at the end. On a docs-only Tier A PR, reuse checks already bound to the same head instead of running them again. Gibson follow-up: the driver could flag N timeouts in a row on the same hat.
- **Links:** PR #15, `gibson/journal.md` state-corrupt entries

## 2026-11-04 — loop-target-is-the-feature-worktree

- **What happened:** After merging #15, the release hat could not remove the feature worktree or delete local branch `feat/14-readme-project-status` (Law 10). That worktree is the driver's `--repo` target, and it holds the gitignored `gibson/` state.
- **Root cause:** The loop was pointed at a feature worktree, not at a stable checkout that each builder branches from.
- **Fix / rule:** Do not remove the driver's own target worktree from inside a hat. Leave it, note it in loop-state, and let a human or the driver move it to `main`. Builders create their own worktree per issue. Gibson follow-up: decide where the driver's state dir lives, separate from per-issue worktrees.
- **Links:** PR #15

## 2026-11-04 — guard-push-needs-a-real-push-test

- **What happened:** Under `loop.sh`, allowed pushes through `repo-boundary-guard.sh` failed (`git: 'origin' is not a git command`). Every guard test checked that a push was refused, and none checked that an allowed push went through.
- **Fix / rule:** The fix is Gibson lesson L-098 (the guard puts `push` back, and a sensor now does a real push to a local bare repo). Do not bypass the guard with `/usr/bin/git`. If an allowed push fails, park and quote the error.
- **Links:** Gibson L-098
