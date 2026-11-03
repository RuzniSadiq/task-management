# evidence/

Machine-readable records of control executions, committed through reviewed pull
requests so they are retained and linked to the commit they were taken against.
Each file states the control, its FINOS references, the exact `main` and Gibson
commits tested, every attempt with its expected and observed outcome, and a
pass/fail summary.

| File | Control | Issue |
|---|---|---|
| `P2-agent-least-privilege.json` | P2 — Agent least privilege (FINOS AIGF MI-18 v3) | [#11](https://github.com/RuzniSadiq/task-management/issues/11) |

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
