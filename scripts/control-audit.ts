// control-audit.ts — detective control over the delivery process (issue #41).
//
// Branch protection and the review lane are the preventive side. This script is the detective
// side: it re-checks, from GitHub's own records, that what reached `main` followed the rules in
// .gibson-delivery.json, and that the live branch protection still matches that file.
//
// For each PR merged into main since a base date it checks:
//   merged-via-pr                 the change reached main through a merged pull request
//   independent-approval-at-head  the reviewer identity's latest verdict is APPROVED at the exact head SHA
//   required-checks-green         every required check's latest run at that head succeeded
//   dco-signoff                   every commit carries a Signed-off-by trailer
//   agent-vendor-trailer          every commit carries exactly one Agent-Vendor, all the same (authorVendor)
//   vendor-separation             the approving review's vendor is the one pickReviewer selects for the author's vendor
// And for the repository:
//   branch-protection             live protection of main equals .gibson-delivery.json
//   no-direct-push                every commit on main since the base belongs to a merged PR
//
// Output: JSONL evidence (task-management.control-evidence/v1, one record per PR per control, plus
// one per repository control), always written. One `control-finding` issue is opened per violation
// set (one per PR, one for protection drift, one per direct-push commit) and its body is refreshed
// on later runs, so repeat runs never duplicate or spam. A failure to read anything is a failed
// control with the reason, never a silent pass.
//
// FINOS controls (ids as cited by issue #41): SDLC-SEC-008, RC-005, AIGF MI-21 (audit trail),
// AIGF MI-4 (agent accountability).
//
// Usage (needs GH_TOKEN with contents:read, pull-requests:read, issues:write; reading branch
// protection needs administration:read, so give the workflow a CONTROL_AUDIT_TOKEN secret):
//   node scripts/control-audit.ts [--repo owner/name] [--since 2026-11-01T00:00:00Z]
//        [--out control-evidence.jsonl] [--config .gibson-delivery.json] [--dry-run]
// --dry-run reads only: findings are printed, no issue is written.
// All GitHub access goes through the Gh interface, so the tests run with no network.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { authorVendor, pickReviewer, requiredChecksGreen } from "./review-lane-rules.ts";
import type { CheckRun, Review } from "./review-lane-rules.ts";

export const SCHEMA = "task-management.control-evidence/v1";
export const FINDING_LABEL = "control-finding";
export const DEFAULT_REPO = "RuzniSadiq/task-management";
export const DEFAULT_SINCE_DAYS = 30;

export interface PrInfo { number: number; title: string; url: string; mergedAt: string; head: string }
export interface Commit { sha: string; message: string }
export interface PrReview extends Review { body?: string | null }
export interface Issue { number: number; title: string }

/** The subset of the branch-protection API response this control compares. */
export interface Protection {
  required_status_checks?: { strict?: boolean; contexts?: string[]; checks?: { context: string }[] } | null;
  enforce_admins?: { enabled?: boolean } | null;
  required_pull_request_reviews?: { required_approving_review_count?: number; dismiss_stale_reviews?: boolean } | null;
  allow_force_pushes?: { enabled?: boolean } | null;
  allow_deletions?: { enabled?: boolean } | null;
}

/** What .gibson-delivery.json declares (the fields this control needs). */
export interface DeliveryConfig { defaultBranch: string; requiredContexts: string[]; reviewerLogin: string }

/** Every GitHub call the control makes. List methods paginate fully. Methods throw on a gh failure. */
export interface Gh {
  /** Every PR merged into `branch`. */
  mergedPrs(branch: string): PrInfo[];
  commits(pr: number): Commit[];
  reviews(pr: number): PrReview[];
  checkRuns(sha: string): CheckRun[];
  protection(branch: string): Protection;
  /** Commits on `branch` made since this instant (ISO). */
  branchCommits(branch: string, since: string): Commit[];
  /** Numbers of PRs merged into `branch` that contain this commit. */
  mergedPrsOf(sha: string, branch: string): number[];
  ensureLabel(): void;
  openFindings(): Issue[];
  createIssue(title: string, body: string): number;
  updateIssue(issue: number, body: string): void;
}

export type Result = "pass" | "fail";
export interface Run { url: string; attempt: string }

export interface Control { id: string; catalog: string; version: string; check: string; name: string }
const SDLC = "FINOS SDLC Common Controls";
const AIGF = "FINOS AI Governance Framework";
const control = (id: string, catalog: string, check: string, name: string): Control => ({ id, catalog, version: "1", check, name });
export const CONTROLS = {
  viaPr: control("SDLC-SEC-008", SDLC, "merged-via-pr", "Changes reach main through a pull request"),
  approval: control("SDLC-SEC-008", SDLC, "independent-approval-at-head", "Independent approval at the exact head SHA"),
  checks: control("RC-005", SDLC, "required-checks-green", "Required checks green at the head"),
  dco: control("MI-21", AIGF, "dco-signoff", "Every commit is signed off (audit trail)"),
  trailer: control("MI-4", AIGF, "agent-vendor-trailer", "Every commit declares exactly one Agent-Vendor"),
  separation: control("MI-4", AIGF, "vendor-separation", "Reviewer vendor differs from author vendor"),
  protection: control("SDLC-SEC-008", SDLC, "branch-protection", "Live branch protection equals the declared policy"),
  directPush: control("SDLC-SEC-008", SDLC, "no-direct-push", "No commit reaches main without a merged pull request"),
} as const;

export interface Subject { kind: "pr" | "branch" | "commit"; ref: string; pr?: number; sha?: string }

/** One line of the JSONL evidence file. */
export interface ControlRecord {
  schema: typeof SCHEMA;
  event: "control.evaluated";
  recorded_at: string;
  repository: string;
  run: Run;
  subject: Subject;
  control: Control;
  result: Result;
  reasons: string[];
  /** URLs / SHAs / names the result rests on. */
  evidence: string[];
}

export type Finding =
  | { key: string; title: string; issue: number; action: "opened" | "updated" }
  | { key: string; title: string; issue: null; action: "error"; error: string };

export interface Audit {
  records: ControlRecord[];
  findings: Finding[];
  result: Result;
  /** Set when a whole-run read failed; the result is then fail. */
  errors: string[];
}

export interface Options { repo: string; run: Run; now: () => string; since: string; config: DeliveryConfig }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "";
const SIGNED_OFF = /^Signed-off-by:[ \t]*\S.*<[^<>\s]+>[ \t]*$/m;
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*[ \t]*:[ \t]*\S/;
/**
 * The commit's trailer region: the run of paragraphs at the end of the message in which every line
 * is `Key: value` (or an indented continuation), never including the subject paragraph. The Gibson
 * reservation commit puts Agent-Vendor in a paragraph of its own ahead of the other trailers, so
 * more than the last paragraph must count; but a `Signed-off-by:` or `Agent-Vendor:` line in or
 * after ordinary prose is not a trailer, so a prose paragraph ends the region.
 */
export function trailerBlock(message: string): string {
  const paras = message.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n/);
  const isTrailers = (para: string): boolean => para.split("\n").every((l, i) => (i > 0 && /^[ \t]+\S/.test(l)) || TRAILER_LINE.test(l));
  let start = paras.length;
  while (start > 1 && isTrailers(paras[start - 1] ?? "")) start--;
  return paras.slice(start).join("\n");
}
/** The lane's review report opens `## Second opinion — <vendor>`. */
const REVIEWER_VENDOR_ALL = /^##[ \t]+Second opinion[ \t]*[—–-][ \t]*([A-Za-z]+)/gm;

/** Load and validate .gibson-delivery.json. Throws with a readable message. */
export function parseConfig(text: string): DeliveryConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("delivery config is not valid JSON"); }
  const c = raw as { defaultBranch?: unknown; requiredContexts?: unknown; reviewerLogin?: unknown } | null;
  const contexts = c?.requiredContexts;
  if (typeof c?.defaultBranch !== "string" || c.defaultBranch === "") throw new Error("delivery config has no defaultBranch");
  if (typeof c.reviewerLogin !== "string" || c.reviewerLogin === "") throw new Error("delivery config has no reviewerLogin");
  if (!Array.isArray(contexts) || contexts.length === 0 || !contexts.every((x) => typeof x === "string" && x !== "")) {
    throw new Error("delivery config has no requiredContexts");
  }
  return { defaultBranch: c.defaultBranch, reviewerLogin: c.reviewerLogin, requiredContexts: contexts as string[] };
}

type Verdict = { result: Result; reasons: string[]; evidence: string[] };
const verdict = (reasons: string[], evidence: string[]): Verdict => ({ result: reasons.length === 0 ? "pass" : "fail", reasons, evidence });

/** The reviewer's latest verdict at `head`, in API order (chronological), or undefined. */
function latestVerdictAt(reviews: PrReview[], login: string, head: string): PrReview | undefined {
  const mine = reviews.filter((r) => r.user?.login === login && r.commit_id === head
    && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED"));
  return mine.at(-1);
}

/** Never throws: a read failure is a failed control with the reason. */
function gather<T>(read: () => T, what: string, fail: (reason: string) => void): T | undefined {
  try { return read(); } catch (e) { fail(`could not read ${what}: ${errText(e)}`); return undefined; }
}

/** Evaluate every per-PR control. */
export function evaluatePr(gh: Gh, pr: PrInfo, cfg: DeliveryConfig): { control: Control; verdict: Verdict }[] {
  const out: { control: Control; verdict: Verdict }[] = [];
  const head = pr.head;
  const prRef = pr.url;

  out.push({ control: CONTROLS.viaPr, verdict: verdict(pr.mergedAt === "" ? ["pull request has no merge time"] : [], [prRef]) });

  // approval at the exact head
  const reviewReasons: string[] = [];
  const reviews = gather(() => gh.reviews(pr.number), "reviews", (r) => reviewReasons.push(r));
  let approving: PrReview | undefined;
  if (reviews !== undefined) {
    // Only a verdict submitted no later than the merge counts; a missing or unparseable time is not
    // provably before the merge, so it is excluded (fail closed).
    const merged = Date.parse(pr.mergedAt);
    const beforeMerge = reviews.filter((r) => {
      const t = Date.parse(r.submitted_at ?? "");
      return !Number.isNaN(t) && !Number.isNaN(merged) && t <= merged;
    });
    const latest = latestVerdictAt(beforeMerge, cfg.reviewerLogin, head);
    if (latest === undefined) {
      const late = latestVerdictAt(reviews, cfg.reviewerLogin, head);
      reviewReasons.push(late === undefined ? `no verdict by ${cfg.reviewerLogin} at head ${head}`
        : `no verdict by ${cfg.reviewerLogin} at head ${head} submitted before the merge (the ${late.state} one is after ${pr.mergedAt} or has no valid time)`);
    }
    else if (latest.state !== "APPROVED") reviewReasons.push(`latest verdict by ${cfg.reviewerLogin} at head ${head} is ${latest.state}, not APPROVED`);
    else approving = latest;
  }
  out.push({ control: CONTROLS.approval, verdict: verdict(reviewReasons, [prRef, `head ${head}`]) });

  // required checks at the head
  const checkReasons: string[] = [];
  const runs = gather(() => gh.checkRuns(head), `check runs at ${head}`, (r) => checkReasons.push(r));
  if (runs !== undefined) {
    const green = requiredChecksGreen(runs, cfg.requiredContexts);
    if (!green.ok) checkReasons.push(green.reason);
  }
  out.push({ control: CONTROLS.checks, verdict: verdict(checkReasons, [`head ${head}`, ...cfg.requiredContexts.map((c) => `check ${c}`)]) });

  // commits: DCO, Agent-Vendor
  const commitReasons: string[] = [];
  const commits = gather(() => gh.commits(pr.number), "commits", (r) => commitReasons.push(r));
  const dcoReasons = [...commitReasons];
  const trailerReasons = [...commitReasons];
  let author: ReturnType<typeof authorVendor> | undefined;
  if (commits !== undefined) {
    if (commits.length === 0) { dcoReasons.push("pull request has no commits"); }
    for (const c of commits) if (!SIGNED_OFF.test(trailerBlock(c.message))) dcoReasons.push(`commit ${c.sha} has no Signed-off-by trailer`);
    author = authorVendor(commits.map((c) => trailerBlock(c.message)));
    if ("reason" in author) trailerReasons.push(author.reason);
  }
  const commitRefs = (commits ?? []).map((c) => `commit ${c.sha}`);
  out.push({ control: CONTROLS.dco, verdict: verdict(dcoReasons, commitRefs) });
  out.push({ control: CONTROLS.trailer, verdict: verdict(trailerReasons, commitRefs) });

  // reviewer vendor != author vendor
  const sepReasons: string[] = [];
  if (author === undefined || "reason" in author) sepReasons.push(`author vendor unknown${author === undefined ? "" : ` (${author.reason})`}`);
  if (approving === undefined) sepReasons.push("no approving review to take the reviewer vendor from");
  else {
    const declaredAll = [...(approving.body ?? "").matchAll(REVIEWER_VENDOR_ALL)].map((m) => (m[1] ?? "").toLowerCase());
    const declared = declaredAll[0];
    if (declared === undefined) sepReasons.push("approving review does not declare a reviewer vendor ('## Second opinion — <vendor>')");
    else if (declaredAll.some((d) => d !== declared)) sepReasons.push(`approving review declares conflicting reviewer vendors (${[...new Set(declaredAll)].join(", ")})`);
    else if (author !== undefined && "vendor" in author && declared !== pickReviewer(author.vendor)) {
      sepReasons.push(`reviewer vendor ${declared} is not the vendor selected for author ${author.vendor} (expected ${pickReviewer(author.vendor)})`);
    }
  }
  out.push({ control: CONTROLS.separation, verdict: verdict(sepReasons, [prRef]) });
  return out;
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Drift between the live protection and the declared policy; empty means equal. */
export function protectionDrift(live: Protection, cfg: DeliveryConfig): string[] {
  const drift: string[] = [];
  const rsc = live.required_status_checks;
  const contexts = rsc === null || rsc === undefined ? undefined : (rsc.checks?.map((c) => c.context) ?? rsc.contexts ?? []);
  if (contexts === undefined) drift.push("required status checks are not enabled");
  else if (!sameSet(contexts, cfg.requiredContexts)) drift.push(`required contexts are [${[...contexts].sort().join(", ")}], declared [${[...cfg.requiredContexts].sort().join(", ")}]`);
  if (rsc?.strict !== true) drift.push("strict (branch must be up to date) is off");
  if (live.enforce_admins?.enabled !== true) drift.push("admins are not included (enforce_admins off)");
  const pr = live.required_pull_request_reviews;
  if (pr === null || pr === undefined) drift.push("pull request reviews are not required");
  else {
    if (pr.required_approving_review_count !== 1) drift.push(`required approving reviews is ${pr.required_approving_review_count ?? "unset"}, declared 1`);
    if (pr.dismiss_stale_reviews !== true) drift.push("stale approvals are not dismissed");
  }
  if (live.allow_force_pushes?.enabled !== false) drift.push("force-push is allowed");
  if (live.allow_deletions?.enabled !== false) drift.push("branch deletion is allowed");
  return drift;
}

/** Titles of the findings; dedupe is by exact title among open `control-finding` issues. */
export const prFindingTitle = (n: number): string => `control-finding: PR #${n} merged without meeting the delivery controls`;
export const protectionFindingTitle = (branch: string): string => `control-finding: branch protection of ${branch} drifted from .gibson-delivery.json`;
export const directPushFindingTitle = (sha: string): string => `control-finding: direct push to main (${sha.slice(0, 7)})`;

interface Violation { key: string; title: string; heading: string; failed: ControlRecord[] }

function findingBody(v: Violation, run: Run): string {
  return [
    `${v.heading}`,
    "",
    `- Run: ${run.url}`,
    "",
    ...v.failed.flatMap((r) => [
      `**${r.control.id}** — ${r.control.name} (\`${r.control.check}\`, ${r.control.catalog} v${r.control.version})`,
      ...r.reasons.map((x) => `- ${x}`),
      "",
    ]),
    "Detected by `scripts/control-audit.ts`. This issue is refreshed on each run while the violation set stands; close it once resolved.",
    "",
  ].join("\n");
}

/**
 * Open one issue per violation set, or refresh the body of the one already open. Never throws: a
 * GitHub failure is recorded as an `error` finding so the evidence survives.
 */
function writeFindings(gh: Gh, violations: Violation[], run: Run): Finding[] {
  let open: Issue[];
  try {
    gh.ensureLabel();
    open = gh.openFindings();
  } catch (e) {
    const error = `could not read open findings: ${errText(e)}`;
    return violations.map((v) => ({ key: v.key, title: v.title, issue: null, action: "error", error }));
  }
  return violations.map((v): Finding => {
    const body = findingBody(v, run);
    const existing = open.find((i) => i.title === v.title);
    try {
      if (existing !== undefined) {
        gh.updateIssue(existing.number, body);
        return { key: v.key, title: v.title, issue: existing.number, action: "updated" };
      }
      const number = gh.createIssue(v.title, body);
      open.push({ number, title: v.title });
      return { key: v.key, title: v.title, issue: number, action: "opened" };
    } catch (e) {
      return { key: v.key, title: v.title, issue: null, action: "error", error: `could not ${existing === undefined ? "open" : "update"} the finding: ${errText(e)}` };
    }
  });
}

/** One audit pass. Never throws; returns the records, findings and overall result. */
export function audit(gh: Gh, opts: Options): Audit {
  const { config: cfg } = opts;
  const records: ControlRecord[] = [];
  const violations: Violation[] = [];
  const errors: string[] = [];
  const emit = (subject: Subject, c: Control, v: Verdict): ControlRecord => {
    const rec: ControlRecord = { schema: SCHEMA, event: "control.evaluated", recorded_at: opts.now(), repository: opts.repo, run: opts.run, subject, control: c, result: v.result, reasons: v.reasons, evidence: v.evidence };
    records.push(rec);
    return rec;
  };

  // pull requests merged since the base
  let prs: PrInfo[] = [];
  try {
    prs = gh.mergedPrs(cfg.defaultBranch).filter((p) => Date.parse(p.mergedAt) >= Date.parse(opts.since));
  } catch (e) { errors.push(`could not list merged pull requests: ${errText(e)}`); }
  for (const pr of prs.sort((a, b) => a.number - b.number)) {
    const subject: Subject = { kind: "pr", ref: pr.url, pr: pr.number, sha: pr.head };
    const recs = evaluatePr(gh, pr, cfg).map(({ control: c, verdict: v }) => emit(subject, c, v));
    const failed = recs.filter((r) => r.result === "fail");
    if (failed.length > 0) {
      violations.push({ key: `pr-${pr.number}`, title: prFindingTitle(pr.number), failed,
        heading: `PR #${pr.number} (${pr.url}) "${pr.title}", merged ${pr.mergedAt}, did not meet the delivery controls at head \`${pr.head}\`.` });
    }
  }

  // live branch protection vs declared policy
  const protSubject: Subject = { kind: "branch", ref: cfg.defaultBranch };
  const protReasons: string[] = [];
  const live = gather(() => gh.protection(cfg.defaultBranch), `branch protection of ${cfg.defaultBranch}`, (r) => protReasons.push(r));
  if (live !== undefined) protReasons.push(...protectionDrift(live, cfg));
  const protRec = emit(protSubject, CONTROLS.protection, verdict(protReasons, [`branch ${cfg.defaultBranch}`, ".gibson-delivery.json"]));
  if (protRec.result === "fail") {
    violations.push({ key: "protection", title: protectionFindingTitle(cfg.defaultBranch), failed: [protRec],
      heading: `Live branch protection of \`${cfg.defaultBranch}\` does not equal .gibson-delivery.json.` });
  }

  // direct pushes: commits on the branch with no merged PR
  let commits: Commit[] | undefined;
  try { commits = gh.branchCommits(cfg.defaultBranch, opts.since); } catch (e) { errors.push(`could not list commits on ${cfg.defaultBranch}: ${errText(e)}`); }
  for (const c of commits ?? []) {
    const reasons: string[] = [];
    const merged = gather(() => gh.mergedPrsOf(c.sha, cfg.defaultBranch), `pull requests of ${c.sha}`, (r) => reasons.push(r));
    if (merged !== undefined && merged.length === 0) reasons.push(`commit ${c.sha} is on ${cfg.defaultBranch} with no associated merged pull request (direct push)`);
    const rec = emit({ kind: "commit", ref: c.sha, sha: c.sha }, CONTROLS.directPush, verdict(reasons, [`commit ${c.sha}`, ...(merged ?? []).map((n) => `PR #${n}`)]));
    if (rec.result === "fail") {
      violations.push({ key: `direct-${c.sha}`, title: directPushFindingTitle(c.sha), failed: [rec],
        heading: `Commit \`${c.sha}\` reached \`${cfg.defaultBranch}\` without a merged pull request.` });
    }
  }

  const findings = violations.length > 0 ? writeFindings(gh, violations, opts.run) : [];
  const result: Result = errors.length === 0 && violations.length === 0 && findings.every((f) => f.action !== "error") ? "pass" : "fail";
  return { records, findings, result, errors };
}

/** The real Gh, backed by the `gh` CLI. */
export function ghCli(repo: string): Gh {
  const gh = (args: string[], input?: string): string => {
    const r = spawnSync("gh", args, { input, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    if (r.error !== undefined) throw r.error;
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (${r.status ?? "signal"}): ${r.stderr}`);
    return r.stdout;
  };
  /** Paginated `gh api` whose jq emits one JSON object per line. */
  const list = <T>(path: string, jq: string): T[] =>
    gh(["api", "--paginate", path, "--jq", jq]).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as T);
  return {
    mergedPrs: (branch) => list<PrInfo>(`repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&per_page=100`,
      ".[] | select(.merged_at != null) | {number, title, url: .html_url, mergedAt: .merged_at, head: .head.sha}"),
    commits: (pr) => list<Commit>(`repos/${repo}/pulls/${pr}/commits?per_page=100`, ".[] | {sha, message: .commit.message}"),
    reviews: (pr) => list<PrReview>(`repos/${repo}/pulls/${pr}/reviews?per_page=100`,
      ".[] | {id, user: (if .user == null then null else {login: .user.login} end), state, commit_id, submitted_at, body}"),
    checkRuns: (sha) => list<CheckRun>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      ".check_runs[] | {id, name, status, conclusion, started_at}"),
    protection: (branch) => JSON.parse(gh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`])) as Protection,
    branchCommits: (branch, since) => list<Commit>(`repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=100`,
      ".[] | {sha, message: .commit.message}"),
    mergedPrsOf: (sha, branch) => list<number>(`repos/${repo}/commits/${sha}/pulls?per_page=100`,
      `.[] | select(.merged_at != null and .base.ref == ${JSON.stringify(branch)}) | .number`),
    ensureLabel: () => {
      gh(["label", "create", FINDING_LABEL, "--repo", repo, "--force", "--color", "b60205", "--description", "Detective control finding"]);
    },
    // Paginated (slurped) so a finding beyond the first page is still found and never duplicated.
    openFindings: () => (JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?state=open&labels=${FINDING_LABEL}&per_page=100`])) as Issue[][]).flat()
      .map((i) => ({ number: i.number, title: i.title })),
    createIssue: (title, body) => {
      const url = gh(["issue", "create", "--repo", repo, "--title", title, "--label", FINDING_LABEL, "--body-file", "-"], body).trim();
      const n = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
      if (!Number.isInteger(n)) throw new Error(`gh issue create returned no issue URL: ${url}`);
      return n;
    },
    updateIssue: (issue, body) => { gh(["issue", "edit", String(issue), "--repo", repo, "--body-file", "-"], body); },
  };
}

/** The JSONL evidence file: one record per line. */
export const toJsonl = (records: ControlRecord[]): string => records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");

function main(argv: string[]): number {
  const arg = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const env = process.env;
  const repo = arg("--repo") ?? env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  const out = arg("--out") ?? "control-evidence.jsonl";
  const now = (): string => new Date().toISOString();
  const since = arg("--since") ?? new Date(Date.now() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();
  if (Number.isNaN(Date.parse(since))) { console.log(`ERROR --since is not a date: ${since}`); return 2; }
  let config: DeliveryConfig;
  try { config = parseConfig(readFileSync(arg("--config") ?? ".gibson-delivery.json", "utf8")); } catch (e) { console.log(`ERROR ${errText(e)}`); return 2; }
  const run: Run = env.GITHUB_RUN_ID !== undefined
    ? { url: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`, attempt: env.GITHUB_RUN_ATTEMPT ?? "1" }
    : { url: "local run (no GITHUB_RUN_ID)", attempt: "1" };
  const gh = ghCli(repo);
  if (argv.includes("--dry-run")) {
    gh.ensureLabel = () => undefined;
    gh.openFindings = () => [];
    gh.createIssue = (title) => { console.log(`[dry-run] would open or update: ${title}`); return 0; };
    gh.updateIssue = (issue) => { console.log(`[dry-run] would update #${issue}`); };
  }
  const a = audit(gh, { repo, run, now, since, config });
  writeFileSync(out, toJsonl(a.records));
  for (const e of a.errors) console.log(`ERROR ${e}`);
  for (const r of a.records.filter((x) => x.result === "fail")) {
    console.log(`FAIL ${r.subject.kind} ${r.subject.pr === undefined ? r.subject.ref : `#${r.subject.pr}`} ${r.control.check}`);
    for (const x of r.reasons) console.log(`  - ${x}`);
  }
  for (const f of a.findings) console.log(f.action === "error" ? `finding error (${f.key}): ${f.error}` : `finding ${f.action}: #${f.issue} (${f.key})`);
  console.log(`control-audit: ${a.result} (${a.records.length} record(s) since ${since}); evidence in ${out}`);
  return a.result === "pass" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
