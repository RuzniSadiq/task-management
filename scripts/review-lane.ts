// review-lane.ts — independent review lane for this repository.
//
// Modelled on The Gibson's D-018 reviewer controller (the-gibson memory/DECISIONS.md):
// poll open PRs; the first time a head is green, unreviewed and not past its round cap,
// review it. The review is The Gibson's own `scripts/second-opinion.sh` (cross-vendor,
// read-only), run WITHOUT the reviewer token, so the reviewing AI cannot read it. Its
// slot verdicts are then published by The Gibson's `scripts/formal-review.sh` as the
// reviewer identity, pinned to the head, using the same slot-authority rule as
// second-opinion.sh's own formal path (#290). This lane never merges, edits code or
// decides a verdict itself.
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

export interface CheckRun { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null }
export interface Review { id?: number; user: { login: string } | null; state: string; commit_id: string; submitted_at?: string | null }
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

/**
 * Every required check's latest run at this head completed with success. "Latest" is by
 * started_at, not by ID; if any run lacks a start time, or the newest start time is shared
 * by runs that disagree, recency cannot be established and the check fails closed.
 */
export function requiredChecksGreen(runs: CheckRun[], required: string[]): { ok: true } | { ok: false; reason: string } {
  for (const name of required) {
    const named = runs.filter((r) => r.name === name);
    if (named.length === 0) return { ok: false, reason: `required check '${name}' has not run` };
    const times = named.map((r) => Date.parse(r.started_at ?? ""));
    if (times.some((t) => Number.isNaN(t))) return { ok: false, reason: `required check '${name}' has a run with no start time (recency unknown)` };
    const newest = Math.max(...times);
    const tied = named.filter((_, i) => times[i] === newest);
    const latest = tied[0];
    if (latest === undefined) return { ok: false, reason: `required check '${name}' has not run` };
    if (tied.some((r) => r.status !== latest.status || r.conclusion !== latest.conclusion)) {
      return { ok: false, reason: `required check '${name}' has conflicting runs at the same start time (recency unknown)` };
    }
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

/** The posted review, read back: by the reviewer identity, at the exact head, in the expected state, after this attempt began. */
export function verifyPublished(reviews: Review[], login: string, head: string, event: "approve" | "request-changes", since: string):
  { ok: true; id: number } | { ok: false; reason: string } {
  const want = event === "approve" ? "APPROVED" : "CHANGES_REQUESTED";
  const mine = reviews.filter((r) => r.user?.login === login && r.commit_id === head && Date.parse(r.submitted_at ?? "") >= Date.parse(since));
  if (mine.length !== 1) return { ok: false, reason: `publication uncertain: ${mine.length} new reviews by ${login} at ${head.slice(0, 7)}` };
  const only = mine[0];
  if (only?.state !== want || only.id === undefined) return { ok: false, reason: `publication mismatch: state ${only?.state ?? "none"}, expected ${want}` };
  return { ok: true, id: only.id };
}

/**
 * A captain's bounded exception to the round cap (Gibson docs/review-protocol.md): it applies only to the
 * exact "<pr>@<40-hex head>" named in REVIEW_LANE_CAP_EXCEPTION, so a later push is capped again.
 */
export function capExceptionApplies(value: string | undefined, pr: number, head: string): boolean {
  return value !== undefined && /^\d+@[0-9a-f]{40}$/.test(value) && value === `${pr}@${head}`;
}

/** Fail closed: review only when every condition is positively established. */
export function decide(pr: PrFacts, opts: { login: string; required: string[]; caps: Caps; attempted: boolean; capException?: boolean }): Decision {
  if (pr.state !== "OPEN") return { action: "skip", reason: `PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { action: "skip", reason: "draft" };
  if (pr.baseRefName !== "main") return { action: "skip", reason: `base is ${pr.baseRefName}, not main` };
  if (reviewedAtHead(pr.reviews, opts.login, pr.head)) return { action: "skip", reason: "already reviewed at this head" };
  if (opts.attempted) return { action: "skip", reason: "already attempted at this head (one attempt per head)" };
  const tier = tierOf(pr.labels, opts.caps);
  if (roundCapReached(pr.reviews, opts.login, tier, opts.caps) && opts.capException !== true) {
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

/**
 * Environment for every gh read AND for the reviewing AI: no reviewer token in any form.
 * Removes the reviewer-token variables by name, and every variable whose value contains
 * a given secret (e.g. the reviewer token placed in GH_TOKEN), whatever it is called.
 */
export function readEnv(env: NodeJS.ProcessEnv, secrets: string[] = []): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.GH_REVIEWER_TOKEN;
  delete copy.GIBSON_REVIEWER_TOKEN;
  delete copy.GIBSON_FORMAL_REVIEW; // second-opinion.sh must not publish; the lane publishes after
  const live = secrets.filter((x) => x !== "");
  for (const [k, v] of Object.entries(copy)) {
    if (v !== undefined && live.some((x) => v.includes(x))) delete copy[k];
  }
  return copy;
}

/** Environment for formal-review.sh only: the one process that holds the reviewer token. */
export function publisherEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...readEnv(env, [token]), GH_REVIEWER_TOKEN: token };
}

/**
 * The Gibson's slot-authority rule (second-opinion.sh #290), applied to its
 * "slot:<name> state:<state>" lines: any request-changes → request-changes; every slot
 * approve → approve; anything else (no slots, no-verdict, error) → no formal review.
 */
export function slotEvent(output: string): "approve" | "request-changes" | undefined {
  const states = [...output.matchAll(/slot:\S+ state:(\S+)/g)].map((m) => m[1]);
  if (states.includes("request-changes")) return "request-changes";
  if (states.length > 0 && states.every((st) => st === "approve")) return "approve";
  return undefined;
}

function gh(args: string[]): string {
  const r = run("gh", args, readEnv(process.env));
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** Every page of a GitHub REST list (gh --paginate --slurp returns an array of pages). */
function ghPages<T>(path: string): T[] {
  return ghJson<T[]>(["api", "--paginate", "--slurp", path]);
}

function log(message: string): void {
  console.log(`review-lane: ${message}`);
}

interface Config { repo: string; login: string; required: string[]; caps: Caps; gibson: string; stateDir: string }

function loadConfig(): Config {
  const delivery = JSON.parse(readFileSync(".gibson-delivery.json", "utf8")) as { repo: string; reviewerLogin: string; requiredContexts: string[] };
  const gibson = process.env.GIBSON ?? join(homedir(), "Code", "the-gibson");
  const caps = JSON.parse(readFileSync(join(gibson, "config", "review-round-caps.json"), "utf8")) as Caps;
  const stateDir = resolve("gibson", "review-lane"); // created only when a real review starts (dry-run stays read-only)
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
  const runs = ghPages<{ check_runs: CheckRun[] }>(`repos/${cfg.repo}/commits/${pr.headRefOid}/check-runs?per_page=100`).flatMap((p) => p.check_runs);
  const reviews = ghPages<Review[]>(`repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`).flat();
  const commits = ghPages<{ commit: { message: string } }[]>(`repos/${cfg.repo}/pulls/${pr.number}/commits?per_page=100`).flat();
  return { state: pr.state, isDraft: pr.isDraft, baseRefName: pr.baseRefName, head: pr.headRefOid, labels: pr.labels.map((l) => l.name),
    runs, reviews, commitMessages: commits.map((c) => c.commit.message) };
}

/** "<head>..<base sha>@<base ref>" as GitHub reports it now. */
function rangeOf(cfg: Config, n: number): string {
  return gh(["pr", "view", String(n), "--repo", cfg.repo, "--json", "headRefOid,baseRefOid,baseRefName",
    "-q", '"\\(.headRefOid)..\\(.baseRefOid)@\\(.baseRefName)"']).trim();
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
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(attemptedFile(cfg), JSON.stringify([...readAttempted(cfg), `${pr.number}@${head}`], null, 2));
  const wt = resolve("..", `wt-review-${key}`);
  const started = new Date().toISOString();
  const reviewed = rangeOf(cfg, pr.number);
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
    const r = run("bash", args, readEnv(process.env, [token])); // the reviewing AI never sees the token
    const event = slotEvent(r.out + r.err);
    slot = event ?? `no formal verdict (exit ${r.code})`;
    if (event !== undefined) {
      // Immediately before publishing: same head, base and target as reviewed, and no verdict already there.
      const now = rangeOf(cfg, pr.number);
      const existing = ghPages<Review[]>(`repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`).flat();
      if (now !== reviewed) slot = `not published: range moved during review (${reviewed} → ${now})`;
      else if (reviewedAtHead(existing, cfg.login, head)) slot = "not published: a verdict already exists at this head (reconcile first)";
      else {
        const pub = run(join(cfg.gibson, "scripts", "formal-review.sh"), ["--pr", String(pr.number), "--repo", cfg.repo,
          "--event", event, "--body-file", out, "--commit", head], publisherEnv(process.env, token));
        const back = verifyPublished(ghPages<Review[]>(`repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`).flat(),
          cfg.login, head, event, started);
        if (pub.code !== 0 && !back.ok) slot = `formal-review.sh failed (exit ${pub.code}); ${back.reason}`;
        else slot = back.ok ? `${event} (review ${back.id})` : back.reason;
      }
    }
  } catch (e) {
    slot = `error: ${(e as Error).message}`;
  } finally {
    run("git", ["worktree", "remove", "--force", wt]);
  }
  const posted = ghPages<Review[]>(`repos/${cfg.repo}/pulls/${pr.number}/reviews?per_page=100`).flat()
    .filter((r) => r.user?.login === cfg.login && r.commit_id === head).map((r) => r.state);
  const entry = { at: new Date().toISOString(), started, pr: pr.number, head, author_vendor: d.author, reviewer_vendor: d.reviewer,
    reviewer_login: cfg.login, slot_state: slot, posted_at_head: posted };
  appendFileSync(join(cfg.stateDir, "log.jsonl"), JSON.stringify(entry) + "\n");
  log(`PR #${pr.number} head ${head.slice(0, 7)} — ${d.reviewer} verdict ${slot}; posted at head: [${posted.join(",") || "nothing"}]`);
}

function pass(cfg: Config, opts: { pr?: number; dryRun: boolean }): void {
  const fields = "number,state,isDraft,baseRefName,headRefOid,title,body,labels,closingIssuesReferences";
  // Discovery is the paginated REST list of every open PR; each is then read in full.
  const numbers = opts.pr !== undefined ? [opts.pr]
    : ghPages<{ number: number }[]>(`repos/${cfg.repo}/pulls?state=open&per_page=100`).flat().map((p) => p.number);
  const prs = numbers.map((n) => ghJson<GhPr>(["pr", "view", String(n), "--repo", cfg.repo, "--json", fields]));
  if (prs.length === 0) log("no open pull requests");
  const attempted = readAttempted(cfg);
  let token: string | undefined;
  for (const pr of prs) {
    if (halted()) { log("kill switch set — stopping"); return; }
    const capException = capExceptionApplies(process.env.REVIEW_LANE_CAP_EXCEPTION, pr.number, pr.headRefOid);
    if (capException) log(`PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} — captain's bounded cap exception in effect`);
    const d = decide(prFacts(cfg, pr), { login: cfg.login, required: cfg.required, caps: cfg.caps, capException,
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
