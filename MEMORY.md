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

## 2026-11-04 — runner-cannot-run-gibson-claim-scripts

- **What happened:** During the #27 / PR #30 run, the runner hit the same wall five times. (1) `claim.sh` and `gibson-verify.mjs prove` both call `git -C`, and `repo-boundary-guard.sh` refuses it, so the builder could not claim and the verify receipt is claim-only (NOT RUN). (2) The reviewer could not dry-run `scripts/review-lane.ts` (permission prompt). (3) The release hat could not run `release-claim.sh` (permission prompt). (4) The release hat could not read `RELEASE_CMD` (`printenv` needed approval). (5) A `cd <worktree> && git …` compound command was refused because it changes directory before a git call. In every case the runner stopped and did not bypass anything. The merge still landed (834c743), but the worktree, the branch and the `agent-claimed` label on #27 stayed until the supervisor cleaned them up.
- **Root cause:** The runner's tool allow-list and the guard do not cover the Gibson lifecycle scripts the playbooks tell each hat to run (claim at the start, verify, review dry-run, release cleanup at the end). In a headless loop, any approval prompt is a refusal. Those steps fall back to the supervisor, and a hat that does not write them down leaves orphaned claims behind.
- **Fix / rule:** Hats do not retry a refused command, and they never get around it with `/usr/bin/git`, `env` tricks or similar. Write the exact command the supervisor must run (with its env and the expected exit code) into loop-state `next_action`, and do not start the next issue until it has run. Run git from the cwd or with absolute paths, not `cd X && git …`. Pass `RELEASE_CMD` into the rendered prompt, not only the environment. Harness follow-ups (owner decision, kept local to the Gibson pin): make `claim.sh` and `gibson-verify.mjs` work without `git -C`, or have the guard allow `-C` when it points at this repo's own worktrees; and add `claim.sh` and `release-claim.sh` to the runner allow-list. Both changes touch security-boundary files, so a human must approve them.
- **Links:** PR #30, issue #27, `gibson/journal.md` entries from 2026-11-04 15:19 to 15:51 UTC

## 2026-11-04 — release-claim-closes-the-pr

- **What happened:** (1) PR #32 (issue #28) was approved and green, but it was closed unmerged at 16:45 UTC. The claim was released (`release-claim.sh`) before the merge. That script closes the PR and deletes the branch, so #28 had to be rebuilt as PR #34 on current main, and it needed a new approval. (2) Afterwards, loop-state said `hat: release` / `next_hat: historian` for PR #34, but the PR was still OPEN, there was no release journal entry, and nothing had merged. The historian caught that only by asking GitHub directly.
- **Root cause:** `release-claim.sh` is cleanup to run after the merge, not a merge step. Nothing in the order of steps stops anyone from running it on an open PR. The loop-state `hat` field was also set by hand to "release done" without anything confirming MERGED.
- **Fix / rule:** Run `release-claim.sh` only after `gh pr view <N> --json state` returns `MERGED`. Never run it on an OPEN PR. Every hat that follows release (historian included) first checks `gh pr view <N> --json state,mergeCommit`, and if it is not MERGED, sends the loop back to `release` rather than starting new work. Never write `hat: release` into loop-state unless a release journal entry names the merge commit. Harness follow-up (owner decision, kept local to the Gibson pin): have `release-claim.sh` refuse an OPEN PR unless `--abandon` is passed.
- **Links:** PR #32 (closed), PR #34, issue #28

## 2026-11-05 — assessment-review-lessons

- **What happened:** Six review rounds on one evidence-script PR (#66), each finding a new fail-open pass condition; a `gh run rerun --failed` on a PR broke `test-integrity` (the base artifact belongs to attempt 1); FINOS ids and versions cited in code (MI-4, MI-21, RC-005, OP-007, version "1") did not match the catalogues.
- **Root cause:** Fixing only the cited line instead of sweeping the whole defect class; trusting ids from an issue text instead of the catalogue source; re-running only the failed job of a multi-job artifact pipeline.
- **Fix / rule:** Before review, list every pass condition in a verifier and make each assert content (ids, statuses, exit codes, completeness), not just presence or one failing value. Verify any FINOS id and version against the source repos (finos-labs/SDLC-Controls-Framework, finos/ai-governance-framework) and let a test compare emitted ids to `controls.json`. Re-run the whole workflow, or push an empty signed commit, never `rerun --failed` on a PR with test-integrity.
- **Links:** PR #66, PR #71, issue #64

