// review-lane.ts — independent review lane for this repository.
//
// Modelled on The Gibson's D-018 reviewer controller (the-gibson memory/DECISIONS.md):
// poll open PRs; the first time a head is green, unreviewed and not past its round cap,
// review it. Every review action is The Gibson's own `scripts/second-opinion.sh`
// (cross-vendor, read-only) with GIBSON_FORMAL_REVIEW=1, which publishes the verdict
// through `scripts/formal-review.sh` as the reviewer identity. This lane never merges,
// edits code or decides a verdict itself.
//
// Run it in a reviewer-only terminal (the reviewer token must never reach a builder):
//   node scripts/review-lane.ts            watch every 60s
//   node scripts/review-lane.ts --once     one pass over open PRs
//   node scripts/review-lane.ts --pr 14    review one PR once
//   node scripts/review-lane.ts --dry-run  show decisions; no review, nothing posted
// Stop: Ctrl-C, or the Gibson kill switch (gibson/HALT file or GIBSON_HALT=1).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Vendor = "claude" | "codex" | "grok" | "devin";
const VENDORS: readonly string[] = ["claude", "codex", "grok", "devin"];

export interface CheckRun { id: number; name: string; status: string; conclusion: string | null }
export interface Review { user: { login: string } | null; state: string; commit_id: string }
export type Caps = Record<string, number | string>;
export type Decision =
  | { action: "review"; author: Vendor; reviewer: Vendor }
  | { action: "skip"; reason: string };

/** The single Agent-Vendor declared across a PR's commits, or why there isn't one. */
export function authorVendor(messages: string[]): { vendor: Vendor } | { reason: string } {
  const found = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(/^Agent-Vendor:[ \t]*(\S+)[ \t]*$/gim)) {
      if (match[1] !== undefined) found.add(match[1].toLowerCase());
    }
  }
  const vendors = [...found].sort();
  const only = vendors[0];
  if (only === undefined) return { reason: "no Agent-Vendor trailer on any commit" };
  if (vendors.length > 1) return { reason: `mixed vendors: ${vendors.join(",")}` };
  return VENDORS.includes(only) ? { vendor: only as Vendor } : { reason: `unknown vendor: ${only}` };
}

/** Law 5: the reviewer is always a different vendor from the author. */
export function pickReviewer(author: Vendor): Vendor {
  return author === "codex" ? "claude" : "codex";
}

/** Every required check's latest run at this head completed with success. */
export function requiredChecksGreen(runs: CheckRun[], required: string[]): { ok: true } | { ok: false; reason: string } {
  for (const name of required) {
    const latest = runs.filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
    if (latest === undefined) return { ok: false, reason: `required check '${name}' has not run` };
    if (latest.status !== "completed") return { ok: false, reason: `required check '${name}' is ${latest.status}` };
    if (latest.conclusion !== "success") return { ok: false, reason: `required check '${name}' concluded ${latest.conclusion ?? "none"}` };
  }
  return { ok: true };
}

/** A verdict by the reviewer identity already exists at this exact head. */
export function reviewedAtHead(reviews: Review[], login: string, head: string): boolean {
  return reviews.some((r) => r.user?.login === login && r.commit_id === head
    && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"));
}

/** Tier from the PR's tier-a/b/c label; the Gibson caps file supplies the default. */
export function tierOf(labels: string[], caps: Caps): string {
  for (const label of labels) {
    const m = /^tier-([abc])$/i.exec(label);
    if (m?.[1] !== undefined) return m[1].toUpperCase();
  }
  return String(caps.default ?? "A");
}

/** the-gibson config/review-round-caps.json: per-tier cap on CHANGES_REQUESTED rounds. */
export function roundCapReached(reviews: Review[], login: string, tier: string, caps: Caps): boolean {
  const cap = Number(caps[tier] ?? caps[String(caps.default ?? "A")] ?? 1);
  const rounds = reviews.filter((r) => r.user?.login === login && r.state === "CHANGES_REQUESTED").length;
  return rounds >= cap;
}

export interface PrFacts {
  state: string; isDraft: boolean; baseRefName: string; head: string; labels: string[];
  runs: CheckRun[]; reviews: Review[]; commitMessages: string[];
}

/** Fail closed: review only when every condition is positively established. */
export function decide(pr: PrFacts, opts: { login: string; required: string[]; caps: Caps; attempted: boolean }): Decision {
  if (pr.state !== "OPEN") return { action: "skip", reason: `PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { action: "skip", reason: "draft" };
  if (pr.baseRefName !== "main") return { action: "skip", reason: `base is ${pr.baseRefName}, not main` };
  if (reviewedAtHead(pr.reviews, opts.login, pr.head)) return { action: "skip", reason: "already reviewed at this head" };
  if (opts.attempted) return { action: "skip", reason: "already attempted at this head (one attempt per head)" };
  const tier = tierOf(pr.labels, opts.caps);
  if (roundCapReached(pr.reviews, opts.login, tier, opts.caps)) {
    return { action: "skip", reason: `Tier ${tier} round cap reached — captain decision required` };
  }
  const checks = requiredChecksGreen(pr.runs, opts.required);
  if (!checks.ok) return { action: "skip", reason: checks.reason };
  const author = authorVendor(pr.commitMessages);
  if ("reason" in author) return { action: "skip", reason: author.reason };
  return { action: "review", author: author.vendor, reviewer: pickReviewer(author.vendor) };
}

// ---------------------------------------------------------------- side effects

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

/** Environment for every gh read: the reviewer token is removed, so reads use the operator's own login. */
export function readEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.GH_REVIEWER_TOKEN;
  return copy;
}

function gh(args: string[]): string {
  const r = run("gh", args, readEnv(process.env));
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

function log(message: string): void {
  console.log(`review-lane: ${message}`);
}

interface Config { repo: string; login: string; required: string[]; caps: Caps; gibson: string; stateDir: string }

function loadConfig(): Config {
  const delivery = JSON.parse(readFileSync(".gibson-delivery.json", "utf8")) as { repo: string; reviewerLogin: string; requiredContexts: string[] };
  const gibson = process.env.GIBSON ?? join(homedir(), "Code", "the-gibson");
  const caps = JSON.parse(readFileSync(join(gibson, "config", "review-round-caps.json"), "utf8")) as Caps;
  const stateDir = resolve("gibson", "review-lane");
  mkdirSync(stateDir, { recursive: true });
  return { repo: delivery.repo, login: delivery.reviewerLogin, required: delivery.requiredContexts, caps, gibson, stateDir };
}

function reviewerToken(): string {
  const fromEnv = process.env.GH_REVIEWER_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const r = run("security", ["find-generic-password", "-s", "gibson-reviewer-token", "-w"]);
  const token = r.out.trim();
  if (r.code !== 0 || token === "") throw new Error("reviewer token not found (Keychain service gibson-reviewer-token)");
  return token;
}

/** The Gibson kill switch: a gibson/HALT file, or GIBSON_HALT=1. */
export function halted(dir = ".", env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(dir, "gibson", "HALT")) || env.GIBSON_HALT === "1";
}

interface GhPr { number: number; state: string; isDraft: boolean; baseRefName: string; headRefOid: string; title: string; body: string;
  labels: { name: string }[]; closingIssuesReferences: { number: number }[] }

function prFacts(cfg: Config, pr: GhPr): PrFacts {
  const runs = ghJson<{ check_runs: CheckRun[] }>(["api", `repos/${cfg.repo}/commits/${pr.headRefOid}/check-runs?per_page=100`]).check_runs;
  const reviews = ghJson<Review[]>(["api", `repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`]);
  const commits = ghJson<{ commit: { message: string } }[]>(["api", `repos/${cfg.repo}/pulls/${pr.number}/commits?per_page=100`]);
  return { state: pr.state, isDraft: pr.isDraft, baseRefName: pr.baseRefName, head: pr.headRefOid, labels: pr.labels.map((l) => l.name),
    runs, reviews, commitMessages: commits.map((c) => c.commit.message) };
}

function attemptedFile(cfg: Config): string {
  return join(cfg.stateDir, "attempted.json");
}

function readAttempted(cfg: Config): string[] {
  const f = attemptedFile(cfg);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as string[]) : [];
}

function writeTask(cfg: Config, pr: GhPr, key: string): string {
  const issues = new Set<number>(pr.closingIssuesReferences.map((i) => i.number));
  for (const m of pr.body.matchAll(/\bRefs #(\d+)/g)) if (m[1] !== undefined) issues.add(Number(m[1]));
  const parts = [`PR #${pr.number}: ${pr.title}`, "", pr.body];
  for (const n of issues) {
    const issue = ghJson<{ title: string; body: string }>(["issue", "view", String(n), "--repo", cfg.repo, "--json", "title,body"]);
    parts.push("", `## Issue #${n}: ${issue.title} (acceptance criteria)`, issue.body);
  }
  parts.push("", 'OUTPUT FORMAT: your first line must be plain text, exactly "1. VERDICT: APPROVE" or "1. VERDICT: REQUEST_CHANGES" — no bold, no other Markdown on that line.');
  const file = join(cfg.stateDir, `${key}.task.md`);
  writeFileSync(file, parts.join("\n"));
  return file;
}

function review(cfg: Config, pr: GhPr, d: Extract<Decision, { action: "review" }>, token: string): void {
  const head = pr.headRefOid;
  const key = `pr${pr.number}-${head.slice(0, 7)}`;
  writeFileSync(attemptedFile(cfg), JSON.stringify([...readAttempted(cfg), `${pr.number}@${head}`], null, 2));
  const wt = resolve("..", `wt-review-${key}`);
  const started = new Date().toISOString();
  let slot = "unknown";
  try {
    run("git", ["fetch", "-q", "origin", "main", `pull/${pr.number}/head`]);
    const add = run("git", ["worktree", "add", "-q", "--detach", wt, head]);
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.err.trim()}`);
    const out = join(cfg.stateDir, `${key}.md`);
    const args = ["-c", 'source "$1/scripts/lib/wall-timeout.sh" && g="$1" && shift && run_with_wall_timeout 900 "$g/scripts/second-opinion.sh" "$@"', "_",
      cfg.gibson, "--repo", wt, "--reviewers", d.reviewer, "--author", d.author, "--base", "origin/main", "--branch", "HEAD",
      "--gate-status", `required checks green at ${head}`, "--task-file", writeTask(cfg, pr, key),
      "--pr", String(pr.number), "--github-repo", cfg.repo, "--out", out];
    const r = run("bash", args, { ...process.env, GIBSON_FORMAL_REVIEW: "1", GH_REVIEWER_TOKEN: token });
    slot = /slot:\S+ state:(\S+)/.exec(r.out + r.err)?.[1] ?? `no slot state (exit ${r.code})`;
  } catch (e) {
    slot = `error: ${(e as Error).message}`;
  } finally {
    run("git", ["worktree", "remove", "--force", wt]);
  }
  const posted = ghJson<Review[]>(["api", `repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`])
    .filter((r) => r.user?.login === cfg.login && r.commit_id === head).map((r) => r.state);
  const entry = { at: new Date().toISOString(), started, pr: pr.number, head, author_vendor: d.author, reviewer_vendor: d.reviewer,
    reviewer_login: cfg.login, slot_state: slot, posted_at_head: posted };
  appendFileSync(join(cfg.stateDir, "log.jsonl"), JSON.stringify(entry) + "\n");
  log(`PR #${pr.number} head ${head.slice(0, 7)} — ${d.reviewer} verdict ${slot}; posted at head: [${posted.join(",") || "nothing"}]`);
}

function pass(cfg: Config, opts: { pr?: number; dryRun: boolean }): void {
  const fields = "number,state,isDraft,baseRefName,headRefOid,title,body,labels,closingIssuesReferences";
  const prs = opts.pr !== undefined
    ? [ghJson<GhPr>(["pr", "view", String(opts.pr), "--repo", cfg.repo, "--json", fields])]
    : ghJson<GhPr[]>(["pr", "list", "--repo", cfg.repo, "--state", "open", "--json", fields]);
  if (prs.length === 0) log("no open pull requests");
  const attempted = readAttempted(cfg);
  let token: string | undefined;
  for (const pr of prs) {
    if (halted()) { log("kill switch set — stopping"); return; }
    const d = decide(prFacts(cfg, pr), { login: cfg.login, required: cfg.required, caps: cfg.caps,
      attempted: attempted.includes(`${pr.number}@${pr.headRefOid}`) });
    if (d.action === "skip") { log(`PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} — skipped: ${d.reason}`); continue; }
    log(`PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} — ready, author=${d.author} → reviewer=${d.reviewer}`);
    if (opts.dryRun) continue;
    token ??= reviewerToken();
    review(cfg, pr, d, token);
  }
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const prIndex = argv.indexOf("--pr");
  const pr = prIndex >= 0 ? Number(argv[prIndex + 1]) : undefined;
  if (pr !== undefined && !Number.isInteger(pr)) throw new Error("--pr needs a PR number");
  const cfg = loadConfig();
  if (pr !== undefined || argv.includes("--once")) { pass(cfg, { pr, dryRun }); return; }
  log(`watching ${cfg.repo} (reviewer=${cfg.login}, every 60s${dryRun ? ", dry-run" : ""}) — Ctrl-C or gibson/HALT to stop`);
  while (!halted()) {
    try { pass(cfg, { dryRun }); } catch (e) { log(`pass failed (will retry next tick): ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  log("kill switch set — stopping");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
