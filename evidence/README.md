# evidence/

Machine-readable records of control executions, committed through reviewed pull
requests so they are retained and linked to the commit they were taken against.
Each file states the control, its FINOS references, the exact `main` and Gibson
commits tested, every attempt with its expected and observed outcome, and a
pass/fail summary.

| File | Control | Issue |
|---|---|---|
| `P2-agent-least-privilege.json` | P2 — Agent least privilege (FINOS AIGF MI-18 v3) | [#11](https://github.com/RuzniSadiq/task-management/issues/11) |

| `scenarios/a/scenario-a.json`, `app-demo.txt` | Scenario A: the delivered app works, persists across restart, 325 tests pass; PRs, vendors and reviews that delivered it | [#65](https://github.com/RuzniSadiq/task-management/issues/65) |
| `scenarios/b/scenario-b.json` | Scenario B: five controlled failures (canary PRs #6 to #10) and the required check that blocked each | #65 |
| `scenarios/c/` | Scenario C: `verify-release` detects a tampered v0.1.0 tarball, and passes the untouched release | #65 |
| `scenarios/d/` | Scenario D: `audit-query` answers for a commit and for v0.1.0 from retained evidence only | #65 |

Run links for CI-side evidence (branch protection, test-integrity, DCO proof PRs)
are recorded on the issues they belong to (#2, #4).

## Reproduce P2 (agent least privilege)

Prerequisites: the restricted agent token in the Keychain (`gibson-agent-token`, see
the root README), The Gibson cloned at `~/Code/the-gibson`. Every attempt below is
expected to be **refused**; none of them changes anything when the controls work.

**AC3a/AC3b — GitHub refuses the agent token** (expect HTTP 403 or 404):

    T="$(security find-generic-password -s gibson-agent-token -w)"
    GH_TOKEN="$T" gh api repos/RuzniSadiq/task-management/branches/main/protection
    GH_TOKEN="$T" gh api -X PUT repos/RuzniSadiq/task-management/branches/main/protection/enforce_admins
    GH_TOKEN="$T" gh api repos/RuzniSadiq/task-management/actions/secrets
    GH_TOKEN="$T" gh api -X POST repos/RuzniSadiq/task-management/deployments \
      -f ref=main -f environment=proof-agent-token -F auto_merge=false -F 'required_contexts[]'
    unset T

**AC3c — branch protection refuses a direct push to `main`** (expect `GH006: Protected
branch update failed`), from a throwaway worktree:

    git fetch origin
    git worktree add -b proof/push-main ../wt-proof-push origin/main
    git -C ../wt-proof-push commit --allow-empty -m "proof: direct push to main must be refused"
    git -C ../wt-proof-push push origin HEAD:refs/heads/main
    git worktree remove --force ../wt-proof-push && git branch -D proof/push-main

**AC4 — The Gibson's repo-boundary guard refuses gate-config changes** (expect
`runner cannot stage harness control-plane file '.agents/gate.json'`). The guard is
installed exactly as `scripts/loop.sh` installs it:

    git worktree add -b proof/guard ../wt-proof-guard origin/main && cd ../wt-proof-guard
    GB=$(mktemp -d) && ln -s ~/Code/the-gibson/scripts/repo-boundary-guard.sh "$GB/git"
    export GIBSON_REAL_GIT="$(command -v git)" GIBSON_TARGET_REPO="$PWD" \
           GIBSON_EXPECTED_REPO_SLUG=RuzniSadiq/task-management
    sed -i '' 's/"lint": "npm run lint"/"lint": ""/' .agents/gate.json
    PATH="$GB:$PATH" git add .agents/gate.json        # refused by the guard
    cd - && git worktree remove --force ../wt-proof-guard && git branch -D proof/guard


## Reproduce scenarios A to D

Needs node >= 22.18, `gh` (authenticated, read access), `jq` and `curl`. It writes only under
`evidence/scenarios/` and never writes to GitHub (no issues, releases, labels or pushes).

    evidence/run-scenarios.sh          # all four; exit 1 if any scenario fails
    evidence/run-scenarios.sh c d      # a subset

- **A** starts the real server, creates, lists and patches tasks, checks the error codes, restarts the
  server and lists again, runs `npm test`, and records the merged PRs, agent vendors and independent
  reviews that delivered it.
- **B** reads GitHub's recorded check results for the canary PRs (#6 clean, #7 deleted test, #8 skipped
  test, #9 failing assertion, #10 unsigned commit). Each must have failed exactly its expected set of required checks (no more, no fewer; #8 trips both
  `gate` and `test-integrity`) and none may have merged. Scenario B fails if the live required checks of `main`
  cannot be read or differ from `.gibson-delivery.json`.
  The agent-privilege proofs (refused direct push, refused token, repo-boundary guard) are
  `P2-agent-least-privilege.json`.
- **C** runs the real `scripts/verify-release.ts` against the real v0.1.0 release and its attestation. A
  `gh` shim appends one byte to the tarball as it is downloaded, simulating a replaced artefact; the
  detector must fail on the digest mismatches and the attestation. The same detector then passes the
  untouched release. `--dry-run` means the `control-finding` issue is printed, not opened.
- **D** feeds the release record, a fresh `verify-release` record and the `control-audit` JSONL to
  `scripts/audit-query.ts`, which reads only those files, for one commit (PR #62's head) and for the tag.
  Fields the recorded evidence does not contain (the merge commit, author vendor, reviewer login) come
  back `null`, not guessed.
