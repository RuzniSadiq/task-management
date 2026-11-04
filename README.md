# task-management

A small Task Management API, built by AI agents through
[The Gibson](https://github.com/The-AIE/the-gibson).
[FINOS](https://www.finos.org/) controls are planned (not yet in place).

## Project status

The Task Management API is under construction: its endpoints are not implemented yet. Progress is tracked in this repository's issues.

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
     Issues **Read and write**, Commit statuses **Read**, Actions **Read** (Metadata
     **Read** is automatic; there is no Checks permission for fine-grained tokens, and
     check results are readable on this public repo). Leave everything else — including Administration,
     Environments, Deployments, Secrets and Workflows — at **No access**.
2. Store it in the macOS Keychain (never in the repo or a `.env` file):

       security add-generic-password -a "$USER" -s gibson-agent-token -w

3. **Builder shell** (one terminal, used only for the agent). The Gibson loop runs in a
   dedicated loop folder (a detached worktree of `main`; the loop writes its state there,
   never into your checkout), with the restricted token as the active GitHub credential:

       git worktree add --detach ../task-management-loop origin/main
       export GH_TOKEN="$(security find-generic-password -s gibson-agent-token -w)"
       gh auth status                      # must show "… (GH_TOKEN)" as the active source
       env | grep -c GH_REVIEWER_TOKEN     # must print 0: the reviewer token is not here
       GIBSON_AGENT_VENDOR=claude ~/Code/the-gibson/scripts/loop.sh --runner claude \
         --repo ../task-management-loop --repo-slug RuzniSadiq/task-management

   The Claude runner starts in `acceptEdits` mode, which approves file edits only. Rather
   than `bypassPermissions` (which would also let an agent call `/usr/bin/git` and skip
   the Gibson's git guard), give the loop folder a narrow local allow-list in
   `../task-management-loop/.claude/settings.local.json` (machine-specific, never committed;
   replace `<home>` with your home directory):

       {
         "permissions": {
           "allow": [
             "Bash(gh *)", "Bash(git *)", "Bash(npm *)", "Bash(node *)",
             "Bash(<home>/Code/the-gibson/scripts/*)",
             "Read(/<home>/Code/the-gibson/**)",
             "Read(/<home>/Code/wt-*/**)", "Edit(/<home>/Code/wt-*/**)"
           ],
           "additionalDirectories": ["<home>/Code/the-gibson"]
         }
       }

   This is a convenience for the runner, not a security control: the controls are the
   restricted token, branch protection and the independent review.

4. **Reviewer shell** (a separate terminal, left running). The review lane is the only
   process that reads the reviewer token. Every 60 seconds it looks for open PRs whose
   required checks are green and that have no verdict at their current head, then runs
   The Gibson's `second-opinion.sh` (Codex, read-only, for a Claude-authored PR) **without**
   the token, and publishes the verdict through The Gibson's `formal-review.sh` as
   `ruzni-reviewer`, pinned to that commit and read back afterwards. It never merges or
   edits code:

       cd <a checkout of this repo used only for reviewing>
       node scripts/review-lane.ts              # watch mode
       node scripts/review-lane.ts --dry-run    # show decisions; reads only, writes nothing
       node scripts/review-lane.ts --pr <N>     # one PR, once

   It reads the token from the Keychain (`gibson-reviewer-token`) and stops on the Gibson
   kill switch (`gibson/HALT` in that checkout, or `GIBSON_HALT=1`). It reviews a PR only
   when every commit carries exactly one `Agent-Vendor` trailer, and always picks a
   reviewer of a different vendor (Gibson Law 5). The review task includes the Gibson's
   blocker definition (`docs/review-protocol.md`), so notes are reported as notes. After
   the per-tier round cap (The Gibson's `config/review-round-caps.json`) the lane stops and
   the captain decides; a captain's one-off exception is recorded on the PR and passed as
   `REVIEW_LANE_CAP_EXCEPTION=<pr>@<full head sha>`, and covers that exact commit only.
   Decision rules: `scripts/review-lane-rules.ts`; runner: `scripts/review-lane.ts`.

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