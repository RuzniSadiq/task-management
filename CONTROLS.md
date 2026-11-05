<!-- Generated from controls.json by scripts/gen-controls-md.ts. Do not edit by hand. -->

# Control implementation matrix

Each control below is implemented in executable code or pipeline configuration, not in an agent's prompt.
FINOS references were checked against the frameworks' source repositories:

- FINOS SDLC Common Controls Catalog: https://github.com/finos-labs/SDLC-Controls-Framework (Pre-alpha catalog; each risk and mitigation carries its own version and status. Ids are SDLC-TYPE-NNN.)
- FINOS AI Governance Framework v3 (2026-10-26): https://github.com/finos/ai-governance-framework

| Id | Control | Type | FINOS reference | Mechanism | Evidence |
|---|---|---|---|---|---|
| P1 | Deployment gating | preventative | SDLC-PREV-012 Deployment Gating (mitigation, SDLC v0.2); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1) | `.gibson-delivery.json`, `.github/workflows/gibson-gate.yml`, `.github/workflows/dco.yml`, `.github/workflows/release.yml` | closed canary PRs #6 to #10; release-evidence.json attached to each release |
| P2 | Agent least privilege | preventative | MI-18 Agent Authority Least Privilege Framework (mitigation, AIGF v3 (2026-10-26)); RI-24 Agent Action Authorization Bypass (risk, AIGF v3 (2026-10-26)); SDLC-SEC-013 Non-Approved Agentic Processes (risk, SDLC v0.1) | `README.md`, `.gibson-delivery.json`, `evidence/P2-agent-least-privilege.json` | evidence/P2-agent-least-privilege.json |
| P3 | Human release approval | preventative | SDLC-PREV-019 Version Release Approval Gating (mitigation, SDLC v0.2); MI-24 Human-in-the-Loop Action Approval Gate (mitigation, AIGF v3 (2026-10-26)) | `.github/workflows/release.yml` | release-evidence.json (approvals) attached to each release |
| P4 | Independent review | preventative | SDLC-PREV-001 Code Review (mitigation, SDLC v1.0) | `scripts/review-lane.ts`, `scripts/review-lane-rules.ts` | review verdicts on each merged PR; test/review-lane-rules.test.ts |
| P5 | Test integrity and execution | preventative | SDLC-PREV-016 Test Execution and Sign-Off (mitigation, SDLC v0.2) | `.github/workflows/gibson-gate.yml`, `scripts/test-integrity.mjs`, `.agents/gate.json` | closed canary PRs #7 (deleted test), #8 (skipped test), #9 (failing test) |
| P6 | Artefact provenance | preventative | SDLC-PREV-003 Software Artifact Provenance (mitigation, SDLC v0.1); SDLC-PREV-002 Content Addressable Identities (mitigation, SDLC v0.2) | `.github/workflows/release.yml` | release-evidence.json; SHA256SUMS; build attestation |
| D1 | Released artefact re-verification | detective | SDLC-PREV-003 Software Artifact Provenance (mitigation, SDLC v0.1); SDLC-PREV-002 Content Addressable Identities (mitigation, SDLC v0.2); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1) | `scripts/verify-release.ts`, `.github/workflows/verify-release.yml` | verify-release-evidence.json (task-management.control-evidence/v1) uploaded by each run; control-finding issues |
| D2 | Delivery process audit | detective | MI-21 Agent Decision Audit and Explainability (mitigation, AIGF v3 (2026-10-26)); MI-4 AI System Observability (mitigation, AIGF v3 (2026-10-26)); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1); SDLC-RC-005 Audit and Compliance Evidence Failure (risk, SDLC v0.1) | `scripts/control-audit.ts`, `.github/workflows/control-audit.yml` | control-evidence.jsonl uploaded by each run; control-finding issues |
| D3 | Audit evidence query | detective | MI-21 Agent Decision Audit and Explainability (mitigation, AIGF v3 (2026-10-26)); SDLC-RC-005 Audit and Compliance Evidence Failure (risk, SDLC v0.1) | `scripts/audit-query.ts` | its JSON output for a given commit or tag |

## P1 Deployment gating (preventative)

**FINOS:** SDLC-PREV-012 Deployment Gating (mitigation, SDLC v0.2); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1)

**Risk addressed:** Unreviewed or failing software reaches main or is released.

**How it operates:** Branch protection on main requires the gate, security-fast, test-integrity and DCO checks (strict), one approving review from the independent reviewer identity after the last push, and applies to admins. release.yml re-runs the gate and checks ancestry and version before publishing.

**Mechanism:** `.gibson-delivery.json`, `.github/workflows/gibson-gate.yml`, `.github/workflows/dco.yml`, `.github/workflows/release.yml`

**Independent verification:**

- `gh api repos/RuzniSadiq/task-management/branches/main/protection`
- `scripts/delivery-control/audit.sh --repo RuzniSadiq/task-management (The Gibson)`

**Evidence:**

- closed canary PRs #6 to #10
- release-evidence.json attached to each release

## P2 Agent least privilege (preventative)

**FINOS:** MI-18 Agent Authority Least Privilege Framework (mitigation, AIGF v3 (2026-10-26)); RI-24 Agent Action Authorization Bypass (risk, AIGF v3 (2026-10-26)); SDLC-SEC-013 Non-Approved Agentic Processes (risk, SDLC v0.1)

**Risk addressed:** An agent changes protections, reads secrets or lands code outside its authority.

**How it operates:** Agents run with a fine-grained token scoped to this repository without administration, secrets, workflow or environment rights; GitHub refuses the rest. The Gibson repo-boundary guard refuses commits that leave the repository or touch gate configuration. Branch protection refuses direct pushes to main for every credential.

**Mechanism:** `README.md`, `.gibson-delivery.json`, `evidence/P2-agent-least-privilege.json`

**Independent verification:**

- `follow evidence/README.md, section Reproduce P2: every attempt must be refused`

**Evidence:**

- evidence/P2-agent-least-privilege.json

## P3 Human release approval (preventative)

**FINOS:** SDLC-PREV-019 Version Release Approval Gating (mitigation, SDLC v0.2); MI-24 Human-in-the-Loop Action Approval Gate (mitigation, AIGF v3 (2026-10-26))

**Risk addressed:** An agent-built artefact is published without a named human accepting it.

**How it operates:** The publish job of release.yml runs in the `release` environment, which needs approval by a named human before any asset is uploaded. The approval is recorded in release-evidence.json.

**Mechanism:** `.github/workflows/release.yml`

**Independent verification:**

- `gh api repos/RuzniSadiq/task-management/environments/release`

**Evidence:**

- release-evidence.json (approvals) attached to each release

## P4 Independent review (preventative)

**FINOS:** SDLC-PREV-001 Code Review (mitigation, SDLC v1.0)

**Risk addressed:** An agent's change is approved by the same vendor or identity that wrote it.

**How it operates:** The review lane publishes a verdict as the reviewer identity only for a PR whose commits each declare one Agent-Vendor, and always picks a reviewer of a different vendor. Branch protection requires that approval at the latest head.

**Mechanism:** `scripts/review-lane.ts`, `scripts/review-lane-rules.ts`

**Independent verification:**

- `node --test test/review-lane-rules.test.ts`
- `node scripts/review-lane.ts --dry-run`

**Evidence:**

- review verdicts on each merged PR
- test/review-lane-rules.test.ts

## P5 Test integrity and execution (preventative)

**FINOS:** SDLC-PREV-016 Test Execution and Sign-Off (mitigation, SDLC v0.2)

**Risk addressed:** A change passes the gate by deleting, skipping or weakening tests.

**How it operates:** The test-integrity job grades the PR against the merge-base copy of scripts/test-integrity.mjs and fails on deleted or skipped tests; the gate job runs typecheck, lint, test and build.

**Mechanism:** `.github/workflows/gibson-gate.yml`, `scripts/test-integrity.mjs`, `.agents/gate.json`

**Independent verification:**

- `npm run typecheck && npm run lint && npm test && npm run build`

**Evidence:**

- closed canary PRs #7 (deleted test), #8 (skipped test), #9 (failing test)

## P6 Artefact provenance (preventative)

**FINOS:** SDLC-PREV-003 Software Artifact Provenance (mitigation, SDLC v0.1); SDLC-PREV-002 Content Addressable Identities (mitigation, SDLC v0.2)

**Risk addressed:** A released artefact cannot be tied to the pipeline run and approval that produced it.

**How it operates:** release.yml signs a build attestation bound to the tarball sha256 and publishes SHA256SUMS and release-evidence.json naming the artefact by digest.

**Mechanism:** `.github/workflows/release.yml`

**Independent verification:**

- `gh attestation verify <tarball> --repo RuzniSadiq/task-management --signer-workflow RuzniSadiq/task-management/.github/workflows/release.yml`

**Evidence:**

- release-evidence.json
- SHA256SUMS
- build attestation

## D1 Released artefact re-verification (detective)

**FINOS:** SDLC-PREV-003 Software Artifact Provenance (mitigation, SDLC v0.1); SDLC-PREV-002 Content Addressable Identities (mitigation, SDLC v0.2); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1)

**Risk addressed:** A released artefact or its records are replaced after release.

**How it operates:** A separate scheduled workflow downloads every published release, recomputes sha256 against SHA256SUMS and release-evidence.json, verifies the attestation is from release.yml on the release tag, fails an empty published release, and opens a control-finding issue on any mismatch.

**Mechanism:** `scripts/verify-release.ts`, `.github/workflows/verify-release.yml`

**Independent verification:**

- `node scripts/verify-release.ts --repo RuzniSadiq/task-management --dry-run`
- `node --test test/verify-release.test.ts`

**Evidence:**

- verify-release-evidence.json (task-management.control-evidence/v1) uploaded by each run
- control-finding issues

## D2 Delivery process audit (detective)

**FINOS:** MI-21 Agent Decision Audit and Explainability (mitigation, AIGF v3 (2026-10-26)); MI-4 AI System Observability (mitigation, AIGF v3 (2026-10-26)); SDLC-SEC-008 Unauthorised Change (risk, SDLC v0.1); SDLC-RC-005 Audit and Compliance Evidence Failure (risk, SDLC v0.1)

**Risk addressed:** A change reaches main without the independent approval, green checks, sign-off or agent identity the policy requires, or branch protection drifts.

**How it operates:** A scheduled workflow re-checks, from GitHub's records, every PR merged since the baseline (approval at the exact head, required checks, DCO, one Agent-Vendor per commit, reviewer vendor differs), the live branch protection against .gibson-delivery.json, and direct pushes. It writes JSONL evidence, files one control-finding per violation, and honours only exact, reviewed waivers.

**Mechanism:** `scripts/control-audit.ts`, `.github/workflows/control-audit.yml`

**Independent verification:**

- `node scripts/control-audit.ts --repo RuzniSadiq/task-management --since 2026-11-04T15:00:00Z --dry-run`
- `node --test test/control-audit.test.ts`

**Evidence:**

- control-evidence.jsonl uploaded by each run
- control-finding issues

## D3 Audit evidence query (detective)

**FINOS:** MI-21 Agent Decision Audit and Explainability (mitigation, AIGF v3 (2026-10-26)); SDLC-RC-005 Audit and Compliance Evidence Failure (risk, SDLC v0.1)

**Risk addressed:** An independent party cannot establish from records who changed what, who approved it and which checks it passed.

**How it operates:** audit-query reads only the retained evidence files (no network, no git) and answers, for a commit or release tag, which agent or vendor acted, who approved, which checks passed, which artefact was released and whether it was re-verified, reporting 'no evidence' rather than guessing.

**Mechanism:** `scripts/audit-query.ts`

**Independent verification:**

- `node scripts/audit-query.ts <sha|tag> --evidence <dir> --json`
- `node --test test/audit-query.test.ts`

**Evidence:**

- its JSON output for a given commit or tag

## Labels in the code that do not match the FINOS catalogue

These ids or labels appear in workflows and scripts but do not describe the FINOS control of that id. They are listed so the discrepancy is visible; the registry above uses the verified references.

| Label | Used in | Note |
|---|---|---|
| OP-007 | scripts/verify-release.ts, .github/workflows/verify-release.yml | Not an id in the FINOS SDLC catalog or the AI Governance Framework; a local label for monitoring. |
| MI-4 | scripts/control-audit.ts, .github/workflows/control-audit.yml | Used for the Agent-Vendor trailer and vendor-separation checks. FINOS MI-4 is AI System Observability; the checks fit SDLC-PREV-023 (Agentic Processes Provenance) and SDLC-PREV-001 (Code Review) better. |
| MI-21 | scripts/control-audit.ts, .github/workflows/control-audit.yml | Used for the DCO sign-off check. FINOS MI-21 is Agent Decision Audit and Explainability, which fits the evidence trail but not sign-off. |
| RC-005 | scripts/control-audit.ts, .github/workflows/control-audit.yml | Used as a control id for the required-checks-green check. SDLC-RC-005 is the risk Audit and Compliance Evidence Failure; the matching mitigations are SDLC-PREV-012 and SDLC-PREV-016. |
| SDLC-SEC-008 | scripts/control-audit.ts | Used as a control id for approval, merged-via-PR, protection and direct-push checks. It is the risk Unauthorised Change; the matching mitigations are SDLC-PREV-001 and SDLC-PREV-012. |
