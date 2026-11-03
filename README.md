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

3. Give the agent its own worktree with an HTTPS remote, so `git push` uses the
   restricted token too (via `gh`), not your SSH key:

       git worktree add ../wt-<issue>-<slug> -b feat/<issue>-<slug> origin/main
       git -C ../wt-<issue>-<slug> remote set-url origin https://github.com/RuzniSadiq/task-management.git
       gh auth setup-git

4. Launch The Gibson loop with the restricted token:

       GH_TOKEN="$(security find-generic-password -s gibson-agent-token -w)" \
         ~/Code/the-gibson/scripts/loop.sh --runner claude \
         --repo ../wt-<issue>-<slug> --repo-slug RuzniSadiq/task-management

## Known limitations

- **Agents run as the same OS user as the owner.** An agent process can in principle
  read anything that user can (other credentials, the SSH key). GitHub-side rules
  (branch protection, token permissions) still apply to every action, but the local
  machine is not an isolation boundary. The Gibson states the same limit
  (`docs/22-devin-cloud-supervisor.md`: isolating runners via "separate users, a
  read-only mount, or evidence signed somewhere the runner cannot reach … is a real
  hardening problem and a separate piece of work"). Production improvement: run each
  agent as a separate OS user or in a container holding only its restricted token.