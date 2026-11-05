// Fixture evidence for the audit-query tests, produced by the REAL scripts/control-audit.ts `audit()`
// against a stub Gh, so the tests exercise the exact record shape the producer writes.
import { audit, toJsonl } from "../scripts/control-audit.ts";
import type { Commit, DeliveryConfig, Gh, PrInfo, PrReview } from "../scripts/control-audit.ts";
import type { CheckRun } from "../scripts/review-lane-rules.ts";

const cfg: DeliveryConfig = { defaultBranch: "main", requiredContexts: ["gate", "security-fast", "test-integrity", "DCO"], reviewerLogin: "ruzni-reviewer" };

export interface PrSpec {
  pr: number;
  head: string;
  authorVendor?: string;
  reviewerVendor?: string;
  verdict?: "APPROVED" | "CHANGES_REQUESTED";
  failingCheck?: string;
}

/** JSONL exactly as `control-audit.ts --out` writes it, for the given merged PRs (plus the repo-level records). */
export function controlAuditJsonl(specs: PrSpec[]): string {
  const info = (s: PrSpec): PrInfo => ({ number: s.pr, title: `change ${s.pr}`, url: `https://github.com/o/r/pull/${s.pr}`, mergedAt: "2026-11-03T00:00:00Z", head: s.head });
  const by = (n: number): PrSpec => specs.find((s) => s.pr === n) ?? (() => { throw new Error(`no PR ${n}`); })();
  const gh: Gh = {
    mergedPrs: () => specs.map(info),
    commits: (n): Commit[] => [{ sha: by(n).head, message: `feat: ${n}\n\nAgent-Vendor: ${by(n).authorVendor ?? "claude"}\n\nSigned-off-by: A Dev <dev@example.com>` }],
    reviews: (n): PrReview[] => [{ user: { login: "ruzni-reviewer" }, state: by(n).verdict ?? "APPROVED", commit_id: by(n).head, submitted_at: "2026-11-02T12:00:00Z", body: `## Second opinion — ${by(n).reviewerVendor ?? "codex"}\n\n1. VERDICT` }],
    checkRuns: (sha): CheckRun[] => {
      const bad = specs.find((s) => s.head === sha)?.failingCheck;
      return cfg.requiredContexts.map((name, id) => ({ id, name, status: "completed", conclusion: name === bad ? "failure" : "success", started_at: "2026-11-02T10:00:00Z" }));
    },
    protection: () => ({
      required_status_checks: { strict: true, contexts: [...cfg.requiredContexts] }, enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    }),
    branchPushes: () => [],
    compare: () => [],
    mergedPrsOf: () => [],
    ensureLabel: () => undefined,
    openFindings: () => [],
    createIssue: () => 1,
    updateIssue: () => undefined,
  };
  return toJsonl(audit(gh, { repo: "o/r", run: { url: "https://github.com/o/r/actions/runs/9", attempt: "1" }, now: () => "2026-11-05T00:00:00.000Z", since: "2026-11-01T00:00:00Z", config: cfg }).records);
}
