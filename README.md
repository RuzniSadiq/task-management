# task-management

A small Task Management API, built by AI agents through
[The Gibson](https://github.com/The-AIE/the-gibson).
[FINOS](https://www.finos.org/) controls are planned (not yet in place).

## Requirements

- Node.js 22.18 or later

## Setup (once per clone)

    npm ci
    git config core.hooksPath .githooks   # enforces Signed-off-by on every commit

## Run the checks (the green gate)

    npm run typecheck
    npm run lint
    npm test
    npm run build

## Running agents (least privilege)

Agents never use your own GitHub login. Each developer creates one restricted
token for the agents they run (rules in `AGENTS.md` → "Agent credentials").

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
   - Resource owner: `RuzniSadiq`; Repository access: **Only select repositories** → `task-management`
   - Repository permissions: Contents **Read and write**, Pull requests **Read and write**,
     Issues **Read and write**, Checks **Read**, Commit statuses **Read**, Actions **Read**
     (Metadata **Read** is automatic). Leave everything else — including Administration,
     Environments, Deployments, Secrets and Workflows — at **No access**.
2. Store it in the macOS Keychain (never in the repo or a `.env` file):

       security add-generic-password -a "$USER" -s gibson-agent-token -w

3. **Builder shell** (one terminal, used only for the agent). Give the agent a fresh
   worktree from an up-to-date `main`, set the restricted token, check it is the
   active GitHub credential, and launch The Gibson loop:

       git fetch origin
       WT=../wt-<issue>-<slug>
       git worktree add "$WT" -b feat/<issue>-<slug> origin/main
       export GH_TOKEN="$(security find-generic-password -s gibson-agent-token -w)"
       gh auth status                      # must show "… (GH_TOKEN)" as the active source
       env | grep -c GH_REVIEWER_TOKEN     # must print 0: the reviewer token is not here
       ~/Code/the-gibson/scripts/loop.sh --runner claude \
         --repo "$WT" --repo-slug RuzniSadiq/task-management

4. **Reviewer shell** (a separate terminal). Only this shell reads the reviewer token,
   and only for the review command (The Gibson's `second-opinion.sh`, which runs Codex
   read-only and posts the verdict as `ruzni-reviewer`):

       T="$(security find-generic-password -s gibson-reviewer-token -w)" && [ -n "$T" ] && \
       GIBSON_FORMAL_REVIEW=1 GH_REVIEWER_TOKEN="$T" ~/Code/the-gibson/scripts/second-opinion.sh \
         --repo <review-worktree-at-PR-head> --reviewers codex --author claude \
         --base origin/main --branch HEAD \
         --pr <N> --github-repo RuzniSadiq/task-management; unset T

### What the restricted token does and does not cover

- **Covers** everything the agent does **through GitHub** with `gh` or the API: it
  cannot change branch protection or settings, approve a release, read or change
  secrets, or edit workflows — GitHub refuses those for this token.
- **Does not cover `git push`.** Pushes use the machine's git credentials (here, the
  owner's SSH key). They are governed by **branch protection on `main`**, which
  applies to every credential: no direct push or force-push to `main`, and nothing
  merges without the required checks and an approval from `ruzni-reviewer`.

## Known limitations

- **Agents run as the same OS user as the owner.** An agent process can in principle
  read anything that user can (the owner's `gh` login, the reviewer token in the
  Keychain, the SSH key). GitHub-side rules (branch protection, token permissions)
  still apply to every action, but the local machine is not an isolation boundary,
  and the separate builder/reviewer shells are a convention, not a security boundary. The Gibson states the same limit
  (`docs/22-devin-cloud-supervisor.md`: isolating runners via "separate users, a
  read-only mount, or evidence signed somewhere the runner cannot reach … is a real
  hardening problem and a separate piece of work"). Production improvement: run each
  agent as a separate OS user or in a container holding only its restricted token.