# task-management

A small Task Management API, built by AI agents through
[The Gibson](https://github.com/The-AIE/the-gibson), delivered under FINOS-referenced controls that the
agents cannot switch off, with independent checks that detect violations and keep machine-readable evidence.

The question this repository answers: can AI agents autonomously build and deliver useful software while
an independently enforced control system prevents unacceptable actions, detects violations and records
reliable evidence of what happened?

- **The software:** create, list and update the status of tasks over HTTP, persisted to a local JSON file
  (see [Using the API](#using-the-api)). Agents built it from a plain-English requirement; the approved plan
  is epic [#26](https://github.com/RuzniSadiq/task-management/issues/26).
- **The controls:** 6 preventative and 3 detective, each mapped to a FINOS reference, its risk, its
  mechanism and a command that verifies it independently: **[CONTROLS.md](CONTROLS.md)**
  (generated from `controls.json`; a test fails if it drifts or if code cites an unregistered id).
- **The evidence:** [evidence/](evidence/README.md), reproduced by one command (see
  [Reproduce the scenarios](#reproduce-the-scenarios)).

## Architecture

    requirement ──► Gibson loop (plan → build → test → review → security → release → historian)
                         │ builder agent: Claude (Sonnet 5.5 by default), own worktree and branch per task
                         ▼
                 pull request ◄── review lane (separate terminal, reviewer token): a different
                         │         vendor (Codex) reviews the exact head and publishes a verdict
                         ▼
        PREVENTATIVE (GitHub enforces; the agent has no say)
          branch protection on main: gate, security-fast, test-integrity, DCO (strict), 1 independent approval
          after the last push, admins included, no force push; `release` environment needs a human approval
          release.yml: gate re-run, ancestry and version checks, signed attestation, sha256 records
                         │
                         ▼  merged / released
        DETECTIVE (scheduled GitHub Actions, no access to the builder)
          verify-release  re-downloads every release, re-checks digests and the attestation
          control-audit   re-checks every merged PR, branch protection and direct pushes
                         │  JSONL / JSON evidence (task-management.control-evidence/v1), control-finding issues
                         ▼
          audit-query     answers who / what / which control / result / evidence from retained files only

### How the Gibson is used

- The Gibson loop (the Gibson's own `scripts/loop.sh`, run from a pinned local checkout of The Gibson, not from this
  repository) drives each issue through its hats. Each task is claimed (the Gibson's `claim.sh`) as one branch and one worktree, and the claim line lives in the PR body.
- **Development and evaluation are separated.** The author is Claude; the reviewer is a different vendor
  (Codex), chosen by the review lane, which refuses a PR unless every commit carries exactly one
  `Agent-Vendor` trailer. The reviewer token is read only by the review lane, never by the builder. A
  builder never approves, and Tier C changes (anything under `scripts/*` or `.github/workflows/*`) are merged
  by a human.
- The agent runs with a fine-grained token scoped to this repository (no administration, secrets, workflow
  or environment rights), and the Gibson's repo-boundary guard refuses commits that leave the repository
  or touch gate configuration.

### Design decisions

- **Enforcement lives in GitHub and in CI, not in prompts.** Nothing an agent is told can lift a required
  check or an approval requirement. The proofs are `evidence/P2-agent-least-privilege.json` and the canary PRs.
- **Detectors run separately from the builder** (scheduled workflows with their own token) and re-derive
  their verdicts from GitHub's records instead of trusting what the pipeline said about itself.
- **Failures stay failures.** A waived violation (`control-waivers.json`) is still `fail` in the evidence
  with the waiver attached; waivers are exact (PR, head SHA, check) and never cover an evidence read failure.
  Unreadable evidence fails closed.
- **No new dependencies.** Node's built-in test runner, `node:http` and a JSON file; TypeScript runs
  directly on Node 22.18+.
- **Evidence is linked to what it describes:** commit and PR head SHAs, artefact sha256, run URLs.

## Reproduce the scenarios

    npm ci
    npm run typecheck && npm run lint && npm test && npm run build    # the green gate
    evidence/run-scenarios.sh                                         # scenarios A to D (a read-only gh token is enough)

| Scenario | What it shows | Where |
|---|---|---|
| A: successful delivery | The app is created, listed, updated, survives a restart; the full test suite passes; the PRs, agent vendor and independent reviews that built it | `evidence/scenarios/a/` |
| B: preventative block | Canary PRs #6 to #10 (clean, deleted test, skipped test, failing assertion, unsigned commit) each fail exactly their expected required checks and cannot merge; the rule is the named required check | `evidence/scenarios/b/`, `evidence/P2-agent-least-privilege.json` |
| C: detective finding | `verify-release` fails a v0.1.0 tarball altered after release (digest mismatch and attestation), and passes the untouched release. A real instance: the scheduled run found the published asset replaced and opened [#47](https://github.com/RuzniSadiq/task-management/issues/47) (run 41912866273); the asset was restored and re-verified (run 41913993276) | `evidence/scenarios/c/` |
| D: audit evidence | `audit-query` answers for a commit and for v0.1.0 from retained evidence files only | `evidence/scenarios/d/` |

The detectors also run in CI: `control-audit` and `verify-release` (daily, and on release events). Their
findings are `control-finding` issues.

## Limitations

- **Agents share the owner's OS user.** An agent process could in principle read the owner's `gh` login,
  the Keychain or the SSH key. GitHub-side rules still apply to every action, but the machine is not an
  isolation boundary and the separate builder and reviewer terminals are a convention.
- **Evidence is not tamper-evident.** It is committed through reviewed PRs and uploaded as workflow
  artefacts; nothing signs it or stores it write-once.
- **Detection latency.** Replacing a release asset does not reliably emit an event, so `verify-release`
  can take up to about 24 hours to notice.
- **Scenario C is re-run as a simulated violation** (the real detection is issue #47, above). The tarball is altered in transit by a shim so the real
  detector and real attestation run without changing the real release.
- **The audit window starts at 2026-11-04T15:00Z**, the first PR merged under the Gibson rules. Earlier
  PRs have reviewed waivers in `control-waivers.json`; the repository's root commit has no PR.
- **Identities are recorded per PR, not per action.** `control-audit` records the author, agent vendor,
  reviewer, merge commit and check conclusions for each merged PR (the `actors` object). It does not record
  the model version or the agent run id, and evidence written before that field existed reports those
  facts as unavailable rather than guessing.
- **FINOS mapping is our judgement.** The FINOS catalogues are pre-alpha. Every id, title and version in
  `controls.json` and in the evidence was checked against the catalogues' source repositories, and a test
  fails if `control-audit` cites an id or version that is not in the registry. Which mitigation a check
  evidences (for example, DCO sign-off under SDLC-PREV-008 Version Control) is our reading of the catalogue.
  The monitoring result of `verify-release` carries a local label, `release-monitoring`, not a FINOS id.
- **The Gibson is patched locally** (one fix to the repo-boundary guard's push handling); the runner needs a
  supervisor to run `claim.sh` and `release-claim.sh`.
- 11 moderate `npm audit` advisories in the lint toolchain are tracked in
  [#16](https://github.com/RuzniSadiq/task-management/issues/16).
- Only synthetic data, a local deployment and a single process owning the JSON file.

## Before deploying in a regulated production environment

- Run each agent as its own OS user or container holding only its restricted token; issue GitHub App
  identities instead of machine users, so required-review evidence is recognised by the platform.
- Sign evidence and ship it to a write-once store, with retention and access control, and verify the
  signatures in `audit-query`.
- Make detection event-driven (webhooks, `repository_dispatch`) and alert a person, not only an issue.
- Protect `controls.json`, `control-waivers.json`, `.gibson-delivery.json` and the workflows with
  CODEOWNERS and organisation rulesets; require two approvers for waivers.
- Pin verification to workflow identity, tag and commit; add SBOM, dependency and SAST scanning as
  required checks; resolve the npm advisories.
- Add per-agent identity to every action (agent id, model, run id) in the evidence, and have the FINOS
  working groups confirm the check-to-mitigation mapping.
- Replace the JSON file with a real database, and add authentication.

## Requirements

- Node.js 22.18 or later

## Quick start

Install the dependencies:

    npm ci

Run the tests:

    npm test

Compile the project to `dist/`:

    npm run build

For the full gate (typecheck, lint, test, build), see "Run the checks (the green gate)" below.

## Using the API

### Start the server

    node src/server.ts

Node runs the TypeScript source directly; no build step is needed. The server prints
the address it listens on and the tasks file it uses:

    Task API listening on http://127.0.0.1:3000 (tasks file: data/tasks.json)

Stop it with Ctrl+C. Three environment variables configure it; an unset or empty
variable uses the default:

| Variable | Default | Meaning |
|---|---|---|
| `TASKS_FILE` | `data/tasks.json` | JSON file the tasks are saved to. It and its folder are created on the first write. |
| `HOST` | `127.0.0.1` | Address to listen on (only this machine by default). |
| `PORT` | `3000` | Port to listen on, an integer from 0 to 65535. The server refuses to start otherwise. |

For example:

    TASKS_FILE=/tmp/tasks.json PORT=8080 node src/server.ts

### Tasks

A task looks like this:

    {
      "id": "0b7e2f5c-3c1a-4d8e-9f4a-2a6b1c9d8e7f",
      "title": "Write the README",
      "status": "todo",
      "createdAt": "2026-11-04T17:00:00.000Z",
      "updatedAt": "2026-11-04T17:00:00.000Z"
    }

- `id` is a UUID the server assigns.
- `title` is required. Leading and trailing spaces are removed; the result must not be
  blank and must be at most 200 characters.
- `status` is one of `todo`, `in_progress` or `done`, and is `todo` when not given.
- `createdAt` and `updatedAt` are UTC timestamps. `updatedAt` changes when the status does.

### Create a task: `POST /tasks`

The body is a JSON object with `title` and, optionally, `status`. The response is
`201 Created` with the new task.

    curl -i -X POST http://127.0.0.1:3000/tasks \
      -H 'content-type: application/json' \
      -d '{"title": "Write the README"}'

### List tasks: `GET /tasks`

The response is `200 OK` with a JSON array of every task, oldest first.

    curl -i http://127.0.0.1:3000/tasks

### Update a task's status: `PATCH /tasks/:id/status`

Replace `:id` with the task's `id`. The body is a JSON object with `status`. The
response is `200 OK` with the updated task.

    curl -i -X PATCH http://127.0.0.1:3000/tasks/0b7e2f5c-3c1a-4d8e-9f4a-2a6b1c9d8e7f/status \
      -H 'content-type: application/json' \
      -d '{"status": "in_progress"}'

### Errors

Every error response is JSON with a single `error` field that explains the problem:

    {"error": "title must not be blank"}

| Status | When |
|---|---|
| `400 Bad Request` | The body is not valid JSON, is not a JSON object, has a field the endpoint does not accept, or has an invalid or missing `title` or `status`. |
| `404 Not Found` | No task has that id, or no endpoint matches the path. |
| `405 Method Not Allowed` | The path exists but not for that method. The `Allow` header lists the methods that work. |
| `413 Payload Too Large` | The request body is larger than 64 KiB (65536 bytes). |

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

## Control-audit waivers

`scripts/control-audit.ts` re-checks every merged PR against the delivery controls and opens a
`control-finding` issue for each violation. A violation that has been reviewed and accepted can be
recorded in `control-waivers.json` (schema `task-management.control-waivers/v1`). Each waiver names
one PR, its full 40-character head SHA, one check and a written rationale. There are no wildcards.

- A waived failure stays `result: "fail"` in the JSONL evidence and carries the waiver, so it is
  never rewritten as a pass. It opens no finding and does not turn the run red.
- Any other failure (another check, another head SHA, another PR) still fails the run.
- A missing file means no waivers. An unreadable or malformed file stops the run with exit code 2.
- A waiver is approved by the pull request that adds it: branch protection requires the independent
  review and the commit history records who merged it.
- The scheduled workflow audits from `--since 2026-11-04T15:00:00Z` (see `.github/workflows/control-audit.yml`). Running
  with an earlier `--since` also reports the repository's root commit (`9bcce1f`, "chore: initialize
  project"), which has no pull request because it created the history; that is not waived.

## Known limitations of the agent setup

- **Agents run as the same OS user as the owner.** An agent process can in principle
  read anything that user can (the owner's `gh` login, the reviewer token in the
  Keychain, the SSH key). GitHub-side rules (branch protection, token permissions)
  still apply to every action, but the local machine is not an isolation boundary,
  and the separate builder/reviewer shells are a convention, not a security boundary. The Gibson states the same limit
  (`docs/22-devin-cloud-supervisor.md`: isolating runners via "separate users, a
  read-only mount, or evidence signed somewhere the runner cannot reach … is a real
  hardening problem and a separate piece of work"). Production improvement: run each
  agent as a separate OS user or in a container holding only its restricted token.