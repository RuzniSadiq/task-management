# AGENTS.md — task-management

A TypeScript Task Management REST API supporting task creation, listing, and status updates with persistent storage and automated tests.

Developed under The Gibson (stock flow). Where this file and Gibson's `AGENTS.md` disagree, the Gibson wins.


## Autonomous development contract

This repo is developed by both humans and coding agents. Any agent or harness
working here reads this section first and obeys it. It states repo facts, not
process doctrine — your harness supplies the process.

Machine-readable companion: `.agents/gate.json` (same commands, parseable).

### Shared agent memory

- **Read** root `MEMORY.md` (and optional `memory/`) at session start
  before mutating work.
- **Dual-write:** durable lessons go in the repo memory file, not only in a local
  runtime store.
- **No CI loop for pure memory commits:** if a commit touches **only** shared
  memory markdown (`MEMORY.md`, optional `memory/**`), do **not** run typecheck/lint/test/build and do **not**
  wait on product CI or review gates. Land the lesson on the default branch
  quickly. Mixed memory + product code uses the normal green gate.
- **Append-only** by default; rebase/pull immediately before writing; on conflict
  in dated sections keep both sides. No secrets in memory files.

### Gate commands (the definition of "green" here)
```bash
npm run typecheck
npm run lint
npm test
npm run build
```
All of these must pass before any **product** commit, with **zero new failures versus the
branch point**. Pre-existing failures are recorded, not inherited and not hidden.
Pure memory-only commits are exempt (see Shared agent memory above).

### Ground rules for machine contributors
1. **Never mutate the shared checkout.** One task = one branch = one git
   worktree of your own.
2. **Claim before you touch.** One `- Active-work claim: <slug>` line in an
   open PR body, plus the `agent-claimed` label on the issue. Check open PRs for
   live claims first. Overlapping claim ⇒ stop and coordinate, never race.
3. **Never review or approve your own work.** An independent reviewer — ideally
   a different model — inspects the exact committed head, read-only.
4. **Acceptance criteria are the contract**, verified by a sensor (test, script,
   check), never by assertion.
5. **Report failures verbatim.** Never mark done what you did not verify.
6. **Clean up:** remove the worktree, delete the branch, release the claim.

### Agent credentials (least privilege)
Applies to every agent runtime (Claude Code, Codex, Grok, …) and every developer.
- Agents run with `GH_TOKEN` set to a **fine-grained token scoped to
  `RuzniSadiq/task-management` only**, never the owner's own login. Repository
  permissions: Contents read/write, Pull requests read/write, Issues read/write,
  Metadata read, Checks read, Commit statuses read, Actions read. **Not granted:**
  Administration, Environments, Deployments, Secrets, Workflows. GitHub refuses
  anything outside these (e.g. changing branch protection, approving a release,
  editing workflow files over HTTPS).
- The reviewer identity's token (`ruzni-reviewer`) is used only by the review step
  (`second-opinion.sh` → `formal-review.sh`), never exported to a builder.
- Run agents through The Gibson's `scripts/loop.sh`; it installs
  `scripts/repo-boundary-guard.sh` in front of `git` for every runner, which refuses
  commits/pushes that leave this repository or modify gate configuration.
- Known limit: agents run as the same OS user as the owner (see README). These
  rules are enforced by GitHub and the Gibson driver, not by the agent.

### Hot files (single claimant, own PR)
| File | Rule |
|---|---|
| package.json, package-lock.json | no casual deps; own commit; exact versions only (no `^`/`~`/`latest`) |
| tsconfig.json, tsconfig.build.json, eslint.config.js | gate configuration; never loosen to make the gate pass |
| MEMORY.md | append-only lessons; pure updates skip CI |
| scripts/test-integrity.mjs, scripts/check-active-work.mjs, .githooks/* | vendored verbatim from The Gibson; never edit — update only by re-copying from upstream |

### Framework warnings
- TypeScript is pinned to **5.9.x**: typescript-eslint supports only TS < 6.1. Do not upgrade TypeScript until it does.
- Lint is **ESLint 9 + typescript-eslint (type-checked)**. Do not add oxlint or another linter.
- Lint covers `src/` and `test/`; both must be in `tsconfig.json` `include`.
- Node **≥ 22.18** runs `.ts` directly via type stripping (tests run on source, no build step).
- Relative imports **must** use the `.ts` extension (`./x.ts`, never `./x.js`). `tsc` accepts
  `.js` but Node then fails at runtime with `ERR_MODULE_NOT_FOUND`; the build rewrites
  `.ts` → `.js` in `dist/`.
- `erasableSyntaxOnly` is on: **no `enum`, no `namespace`, no constructor parameter
  properties.** Use union types and plain fields.
- `verbatimModuleSyntax` is on: type-only imports need `import type` / `type` modifiers.
- `node:test`'s `test()`/`describe()` are allow-listed in `no-floating-promises`; every other
  floating promise is a lint error — `await` it, don't disable the rule.

### Deployment truth (verified 2026-11-03)
- Host/project: none (not deployed)
- Production branch: `main` (no hosting provider; releases are tags cut from `main`, approved via the `release` environment — planned). Delivery model `tag-pin` in `.gibson-delivery.json`.
- Merge to main ⇒ nothing is deployed
- Preview deployments: off

### Stop and ask a human for
- Money: none
- Auth and authorization boundaries: none
- PII / consent: none
- Security boundaries: `.githooks/*`, `.github/workflows/*`, `.agents/gate.json`, `.gibson-delivery.json`, `scripts/*` (gate scripts)
- Destructive or irreversible data and schema operations: none
- Secret values, public launches, legal commitments

### Commit and PR conventions
- Branch `feat/<issue>-<slug>`; PR body contains `Closes #N` and the active-work claim line.
- Labels: `gibson`, `tier-a|b|c`, `P0|P1|P2`.
- Every commit is signed off: `git commit -s` (DCO `Signed-off-by` trailer on every PR commit).
- `main` protection policy — configured in `.gibson-delivery.json`, applied with The Gibson's `scripts/delivery-control/apply-branch-protection.sh`; this file is not proof it is live, so check the live state with `scripts/delivery-control/audit.sh --repo RuzniSadiq/task-management`: required checks `gate`, `security-fast`, `test-integrity`, `DCO` (strict — branch must be up to date); 1 approving review from an independent identity (`ruzni-reviewer`) after the last push; stale approvals dismissed; admins included; no force-push or deletion.
