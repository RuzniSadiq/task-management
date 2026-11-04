// review-lane.ts — the review lane runner (issue #21; its decision rules are #20).
//
// Modelled on The Gibson's D-018 reviewer controller: poll open PRs and, the first time a head
// is green, unreviewed and under its round cap, review it. The review is The Gibson's own
// `scripts/second-opinion.sh` (cross-vendor, read-only), run WITHOUT the reviewer token. Its
// slot verdict is published by The Gibson's `scripts/formal-review.sh` as the reviewer
// identity, pinned to the head. Every decision, environment and verdict comes from
// `review-lane-rules.ts`. This runner never posts, merges or edits code itself.
//
// Run it from a checkout of this repo used only for reviewing (the reviewer token must never
// reach a builder):
//   node scripts/review-lane.ts            watch every 60s
//   node scripts/review-lane.ts --once     one pass over open PRs
//   node scripts/review-lane.ts --pr 14    one PR, once
//   node scripts/review-lane.ts --dry-run  show decisions; reads only, writes nothing
// Stop: Ctrl-C, or the Gibson kill switch (gibson/HALT in this checkout, or GIBSON_HALT=1).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { capExceptionApplies, decide, halted, publisherEnv, readEnv, reviewedAtHead, slotEvent, verifyPublished } from "./review-lane-rules.ts";
import type { Caps, CheckRun, Decision, PrFacts, Review } from "./review-lane-rules.ts";

/** The Gibson's blocker definition, word for word (the-gibson docs/review-protocol.md:29–32). */
export const GIBSON_BLOCKER_RULE = "A blocker names a reachable trigger, wrong outcome and file:line or unmet acceptance criterion. "
  + "Nits, speculative risks and optional improvements are notes; a real defect is still blocking when labeled \"Minor\".";

/** Every side effect the runner has. Tests substitute a fake to check what happens, and in what order. */
export interface Io {
  env: NodeJS.ProcessEnv;
  gh(args: string[], env: NodeJS.ProcessEnv): string; // throws on a non-zero exit
  run(cmd: string, args: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string };
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  append(path: string, text: string): void;
  mkdir(path: string): void;
  /** Take an exclusive lock (single-flight, D-018); false if another live lane holds it. */
  lock(path: string): boolean;
  unlock(path: string): void;
  now(): string;
  log(message: string): void;
}

export interface Config {
  repo: string; login: string; required: string[]; caps: Caps; gibson: string;
  root: string; // this review checkout; gibson/HALT and the lane's state live under it
}

interface PrView {
  number: number; state: string; isDraft: boolean; baseRefName: string; baseRefOid: string; headRefOid: string;
  title: string; body: string; labels: { name: string }[]; closingIssuesReferences: { number: number }[];
}
interface Publication { pr: number; head: string; event: "approve" | "request-changes"; since: string; status: string }
interface Range { head: string; base: string; target: string }

const VIEW_FIELDS = "number,state,isDraft,baseRefName,baseRefOid,headRefOid,title,body,labels,closingIssuesReferences";

/** One lane pass. With a token (not dry-run), every gh read and the reviewer strip it by value too. */
export class Lane {
  private readonly cfg: Config;
  private readonly io: Io;
  private readonly token: string | undefined;
  private readonly secrets: string[];
  constructor(cfg: Config, io: Io, token: string | undefined) {
    this.cfg = cfg;
    this.io = io;
    this.token = token;
    this.secrets = token === undefined ? [] : [token];
  }

  private get stateDir(): string { return join(this.cfg.root, "gibson", "review-lane"); }
  private get attemptsFile(): string { return join(this.stateDir, "attempted.json"); }
  private get publicationsFile(): string { return join(this.stateDir, "publications.json"); }
  private safeEnv(): NodeJS.ProcessEnv { return readEnv(this.io.env, this.secrets); }

  private gh(args: string[]): string { return this.io.gh(args, this.safeEnv()); }
  private json<T>(args: string[]): T { return JSON.parse(this.gh(args)) as T; }
  /** Every page of a REST list (gh --paginate --slurp returns an array of pages). */
  private pages<T>(path: string): T[] { return this.json<T[]>(["api", "--paginate", "--slurp", path]); }
  private reviews(n: number): Review[] { return this.pages<Review[]>(`repos/${this.cfg.repo}/pulls/${n}/reviews?per_page=100`).flat(); }
  private view(n: number): PrView { return this.json<PrView>(["pr", "view", String(n), "--repo", this.cfg.repo, "--json", VIEW_FIELDS]); }
  private range(v: PrView): Range { return { head: v.headRefOid, base: v.baseRefOid, target: v.baseRefName }; }

  private list<T>(file: string): T[] {
    const text = this.io.read(file);
    return text === undefined ? [] : JSON.parse(text) as T[];
  }

  private facts(v: PrView): PrFacts {
    const repo = this.cfg.repo;
    return {
      number: v.number, state: v.state, isDraft: v.isDraft, baseRefName: v.baseRefName, head: v.headRefOid,
      labels: v.labels.map((l) => l.name),
      runs: this.pages<{ check_runs: CheckRun[] }>(`repos/${repo}/commits/${v.headRefOid}/check-runs?per_page=100`).flatMap((p) => p.check_runs),
      reviews: this.reviews(v.number),
      commitMessages: this.pages<{ commit: { message: string } }[]>(`repos/${repo}/pulls/${v.number}/commits?per_page=100`).flat().map((c) => c.commit.message),
    };
  }

  /** Before any new publication: settle every recorded one against GitHub (AC6). */
  reconcile(): void {
    const pubs = this.list<Publication>(this.publicationsFile);
    let changed = false;
    for (const p of pubs.filter((x) => x.status === "pending" || x.status.startsWith("uncertain"))) {
      const back = verifyPublished(this.reviews(p.pr), this.cfg.login, p.head, p.event, p.since);
      const status = back.ok ? `published:${back.id}` : `uncertain: ${back.reason}`;
      if (status === p.status) continue; // unchanged: no rewrite, no log spam
      p.status = status;
      changed = true;
      this.io.log(`PR #${p.pr} head ${p.head.slice(0, 7)} — reconciled publication: ${p.status}`);
    }
    if (changed) this.io.write(this.publicationsFile, JSON.stringify(pubs, null, 2));
  }

  /** One pass over open PRs (or one PR). Dry-run reads only: no state, no token, no review. */
  pass(opts: { pr?: number; dryRun: boolean }): void {
    if (halted(this.cfg.root, this.io.env)) { this.io.log("kill switch set — stopping"); return; }
    if (opts.dryRun) { this.scan(opts); return; }
    this.io.mkdir(this.stateDir);
    const lock = join(this.stateDir, "lane.lock");
    if (!this.io.lock(lock)) { this.io.log("another review lane holds the lock — skipping this pass"); return; }
    try {
      this.reconcile();
      this.scan(opts);
    } finally {
      this.io.unlock(lock);
    }
  }

  /**
   * A head is "attempted" once its verdict reached publication (or one already existed), or after
   * two runs whose verdict never did — none returned, or the pre-publication recheck failed
   * (Gibson docs/review-protocol.md: at most one retry after a terminal failure).
   */
  attempted(n: number, head: string): boolean {
    const marks = this.list<string>(this.attemptsFile);
    return marks.includes(`${n}@${head}`) || marks.filter((m) => m === `${n}@${head}#no-verdict`).length >= 2;
  }

  private mark(entry: string): void {
    this.io.write(this.attemptsFile, JSON.stringify([...this.list<string>(this.attemptsFile), entry], null, 2));
  }

  private scan(opts: { pr?: number; dryRun: boolean }): void {
    const numbers = opts.pr !== undefined ? [opts.pr]
      : this.pages<{ number: number }[]>(`repos/${this.cfg.repo}/pulls?state=open&per_page=100`).flat().map((p) => p.number);
    if (numbers.length === 0) this.io.log("no open pull requests");
    for (const n of numbers) {
      if (halted(this.cfg.root, this.io.env)) { this.io.log("kill switch set — stopping"); return; }
      try { this.consider(n, opts.dryRun); } catch (e) { this.io.log(`PR #${n} — skipped: error: ${(e as Error).message}`); } // one PR's error never blocks the others
    }
  }

  private consider(n: number, dryRun: boolean): void {
    const v = this.view(n);
    const short = `PR #${n} head ${v.headRefOid.slice(0, 7)}`;
    const capException = this.io.env.REVIEW_LANE_CAP_EXCEPTION;
    if (capExceptionApplies(capException, n, v.headRefOid)) this.io.log(`${short} — captain's bounded cap exception in effect`);
    const d = decide(this.facts(v), { login: this.cfg.login, required: this.cfg.required, caps: this.cfg.caps,
      attempted: this.attempted(n, v.headRefOid), capException });
    if (d.action === "skip") { this.io.log(`${short} — skipped: ${d.reason}`); return; }
    this.io.log(`${short} — ready, author=${d.author} → reviewer=${d.reviewer}`);
    if (dryRun) return;
    this.review(v, d);
  }

  private taskFile(v: PrView, key: string): string {
    const issues = new Set<number>(v.closingIssuesReferences.map((i) => i.number));
    for (const m of v.body.matchAll(/\bRefs #(\d+)/g)) if (m[1] !== undefined) issues.add(Number(m[1]));
    const parts = [`PR #${v.number}: ${v.title}`, "", v.body];
    for (const n of issues) {
      const issue = this.json<{ title: string; body: string }>(["issue", "view", String(n), "--repo", this.cfg.repo, "--json", "title,body"]);
      parts.push("", `## Issue #${n}: ${issue.title} (acceptance criteria)`, issue.body);
    }
    parts.push("", `BLOCKER RULE (quoted from The Gibson repository's docs/review-protocol.md, which is not part of this checkout): ${GIBSON_BLOCKER_RULE} `
      + "Request changes only for blockers. List notes under a separate Notes heading, and APPROVE when there are no blockers.");
    parts.push("", 'OUTPUT FORMAT: your first line must be plain text, exactly "1. VERDICT: APPROVE" or "1. VERDICT: REQUEST_CHANGES" — no bold, no other Markdown on that line.');
    const file = join(this.stateDir, `${key}.task.md`);
    this.io.write(file, parts.join("\n"));
    return file;
  }

  /** Review one ready PR. Setup failures never consume the head's single attempt (AC5). */
  review(v: PrView, d: Extract<Decision, { action: "review" }>): void {
    const reviewed = this.range(v);
    const key = `pr${v.number}-${reviewed.head.slice(0, 7)}`;
    const wt = resolve(this.cfg.root, "..", `wt-review-${key}`);
    const env = this.safeEnv();
    const started = this.io.now();
    let created = false;
    let verdict = false; // the reviewer returned a verdict for this head
    let settled = false; // the head's attempt is recorded, or deliberately left unconsumed
    let outcome = "unknown";
    this.io.mkdir(this.stateDir);
    try {
      const fetch = this.io.run("git", ["-C", this.cfg.root, "fetch", "-q", "origin", reviewed.target, `pull/${v.number}/head`], env);
      if (fetch.code !== 0) { outcome = `setup failed (fetch): ${fetch.err.trim()}`; return; }
      const add = this.io.run("git", ["-C", this.cfg.root, "worktree", "add", "-q", "--detach", wt, reviewed.head], env);
      if (add.code !== 0) { outcome = `setup failed (worktree): ${add.err.trim()}`; return; }
      created = true;
      // AC4: what is checked out must be exactly the range we decided on
      const wtHead = this.io.run("git", ["-C", wt, "rev-parse", "HEAD"], env).out.trim();
      const base = this.io.run("git", ["-C", wt, "rev-parse", `origin/${reviewed.target}`], env).out.trim();
      if (wtHead !== reviewed.head || base !== reviewed.base) {
        outcome = `setup aborted: checked-out range ${wtHead.slice(0, 7)}..${base.slice(0, 7)} ≠ PR range ${reviewed.head.slice(0, 7)}..${reviewed.base.slice(0, 7)}`;
        return;
      }
      const task = this.taskFile(v, key);
      // the kill switch is re-checked immediately before each irreversible step (reviewer start, publication)
      if (halted(this.cfg.root, this.io.env)) { outcome = "halted before the reviewer started; attempt not consumed"; return; }
      const out = join(this.stateDir, `${key}.md`);
      const r = this.io.run("bash", ["-c", 'source "$1/scripts/lib/wall-timeout.sh" && g="$1" && shift && run_with_wall_timeout 900 "$g/scripts/second-opinion.sh" "$@"', "_",
        this.cfg.gibson, "--repo", wt, "--reviewers", d.reviewer, "--author", d.author, "--base", reviewed.base, "--branch", "HEAD",
        "--gate-status", `required checks green at ${reviewed.head}`, "--task-file", task, "--out", out], env); // AC2: token-free
      // AC5: an attempt is consumed only if second-opinion.sh provably started (its own status
      // lines are present). A launch failure (missing script, timeout helper, interpreter) consumes nothing.
      if (!/^second-opinion\.sh: /m.test(r.out + r.err)) { outcome = `reviewer did not start (exit ${r.code}): ${(r.err.trim().split("\n").pop() ?? "").slice(0, 200)}`; return; }
      const event = slotEvent(r.out + r.err);
      if (halted(this.cfg.root, this.io.env)) { outcome = "halted during the review: not published, attempt not consumed"; return; }
      // a reviewer that ran but returned no verdict allows one retry (review-protocol)
      if (event === undefined) { this.mark(`${v.number}@${reviewed.head}#no-verdict`); outcome = `no formal verdict (exit ${r.code})`; return; }
      verdict = true;
      const p = this.publish(v.number, reviewed, event, out, () => { this.mark(`${v.number}@${reviewed.head}`); settled = true; });
      outcome = p.outcome;
      if (p.halted) settled = true; // a kill switch costs nothing: the review is redone once it is released
    } catch (e) {
      outcome = `error: ${(e as Error).message}`;
    } finally {
      // A verdict that never reached publication (a GitHub error or a moved base in the recheck)
      // counts like a run with no verdict: one retry, so it is neither lost nor re-run forever.
      if (verdict && !settled) this.mark(`${v.number}@${reviewed.head}#no-verdict`);
      if (created) this.io.run("git", ["-C", this.cfg.root, "worktree", "remove", "--force", wt], env);
      this.io.append(join(this.stateDir, "log.jsonl"), JSON.stringify({ at: this.io.now(), started, pr: v.number, head: reviewed.head,
        base: reviewed.base, author_vendor: d.author, reviewer_vendor: d.reviewer, reviewer_login: this.cfg.login, outcome }) + "\n");
      this.io.log(`PR #${v.number} head ${reviewed.head.slice(0, 7)} — ${d.reviewer}: ${outcome}`);
    }
  }

  /**
   * AC6/AC7: re-check, record, publish via formal-review.sh only, read back. Never publishes twice.
   * `consume` records the head's attempt; it is called once the head is settled (published, or a
   * verdict already exists). Any other return leaves it to the caller: one retry, or none for a halt.
   */
  private publish(n: number, reviewed: Range, event: "approve" | "request-changes", out: string, consume: () => void): { outcome: string; halted?: true } {
    if (this.token === undefined) return { outcome: "not published: no reviewer token" };
    const now = this.range(this.view(n));
    if (now.head !== reviewed.head || now.base !== reviewed.base || now.target !== reviewed.target) {
      return { outcome: `not published: range moved during review (${reviewed.head.slice(0, 7)}..${reviewed.base.slice(0, 7)} → ${now.head.slice(0, 7)}..${now.base.slice(0, 7)})` };
    }
    const existing = reviewedAtHead(this.reviews(n), this.cfg.login, reviewed.head);
    const pubs = this.list<Publication>(this.publicationsFile);
    if (existing || pubs.some((p) => p.pr === n && p.head === reviewed.head)) {
      consume();
      return { outcome: existing ? "not published: a verdict already exists at this head" : "not published: a publication is already recorded for this head" };
    }
    // the last kill-switch check, after the recheck reads and immediately before the irreversible step
    if (halted(this.cfg.root, this.io.env)) return { outcome: "not published: kill switch set", halted: true };
    consume();
    // The read-back window opens immediately before publishing, not when the attempt began, so an
    // unrelated review that appeared during the review cannot be taken for ours. GitHub's
    // submitted_at has whole-second precision: floor to the second and step back one, so our own
    // review posted within the same second is still "after" the cutoff. (An existing verdict at
    // this head already blocked publication above.)
    const cutoff = new Date(Math.floor(Date.parse(this.io.now()) / 1000) * 1000 - 1000).toISOString();
    const record: Publication = { pr: n, head: reviewed.head, event, since: cutoff, status: "pending" };
    this.io.write(this.publicationsFile, JSON.stringify([...pubs, record], null, 2)); // recorded BEFORE publishing
    this.io.run(join(this.cfg.gibson, "scripts", "formal-review.sh"), ["--pr", String(n), "--repo", this.cfg.repo, "--event", event,
      "--body-file", out, "--commit", reviewed.head], publisherEnv(this.io.env, this.token));
    const back = verifyPublished(this.reviews(n), this.cfg.login, reviewed.head, event, record.since);
    record.status = back.ok ? `published:${back.id}` : `uncertain: ${back.reason}`;
    this.io.write(this.publicationsFile, JSON.stringify([...pubs, record], null, 2));
    return { outcome: back.ok ? `${event} (review ${back.id})` : record.status };
  }
}

// ---------------------------------------------------------------- real side effects

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The single-flight lock (D-018) on real files. Every step is atomic and fails closed:
 * - the lock appears with its PID already inside it (written to a temp file, then hard-linked into
 *   place), so a reader never sees an empty or half-written lock and mistakes it for a stale one;
 * - a lock with an unreadable holder is treated as held, never as stale;
 * - a stale lock is replaced only by the one contender that holds the takeover guard, and only
 *   after re-reading the lock under that guard, so two contenders cannot both replace it;
 * - unlock removes the lock only if it still holds our PID.
 * A leftover takeover guard (a crash inside the few microseconds it is held) skips passes rather
 * than risking two lanes: remove `lane.lock.takeover` by hand.
 * `hooks` exist for the tests to interleave a second contender at the exact racy points.
 */
export function fileLock(opts: { pid: number; alive: (pid: number) => boolean; hooks?: { afterStaleCheck?: () => void; underGuard?: () => void } }): { lock(path: string): boolean; unlock(path: string): void } {
  const create = (path: string): boolean => {
    const tmp = `${path}.${opts.pid}.tmp`;
    writeFileSync(tmp, String(opts.pid));
    try { linkSync(tmp, path); return true; } catch { return false; } finally { rmSync(tmp, { force: true }); }
  };
  const holderOf = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8").trim() : undefined);
  return {
    lock(path) {
      if (create(path)) return true;
      const held = holderOf(path);
      if (held === undefined) return create(path); // released between our attempt and our read
      const holder = Number(held);
      if (!/^\d+$/.test(held) || holder <= 0) return false; // unreadable holder: fail closed
      if (holder !== opts.pid && opts.alive(holder)) return false;
      opts.hooks?.afterStaleCheck?.();
      const guard = `${path}.takeover`;
      if (!create(guard)) return false; // someone else is replacing it
      try {
        opts.hooks?.underGuard?.();
        const now = holderOf(path);
        if (now === undefined) return create(path);
        if (now !== held) return false; // it changed under us: someone else holds it now
        rmSync(path, { force: true });
        return create(path);
      } finally {
        rmSync(guard, { force: true });
      }
    },
    unlock(path) {
      if (holderOf(path) === String(opts.pid)) rmSync(path, { force: true });
    },
  };
}

function realIo(): Io {
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
  };
  return {
    env: process.env,
    gh(args, env) {
      const r = run("gh", args, env);
      if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${r.err.trim()}`);
      return r.out;
    },
    run,
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
    write(p, t) { // crash-safe: a half-written state file would make every later pass fail on JSON.parse
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, t);
      renameSync(tmp, p);
    },
    append: (p, t) => appendFileSync(p, t),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    ...fileLock({ pid: process.pid, alive }),
    now: () => new Date().toISOString(),
    log: (m) => console.log(`review-lane: ${m}`),
  };
}

function loadConfig(root: string): Config {
  const delivery = JSON.parse(readFileSync(join(root, ".gibson-delivery.json"), "utf8")) as { repo: string; reviewerLogin: string; requiredContexts: string[] };
  const gibson = process.env.GIBSON ?? join(homedir(), "Code", "the-gibson");
  const caps = JSON.parse(readFileSync(join(gibson, "config", "review-round-caps.json"), "utf8")) as Caps;
  return { repo: delivery.repo, login: delivery.reviewerLogin, required: delivery.requiredContexts, caps, gibson, root };
}

function reviewerToken(io: Io): string {
  const fromEnv = io.env.GH_REVIEWER_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const r = io.run("security", ["find-generic-password", "-s", "gibson-reviewer-token", "-w"], readEnv(io.env));
  const token = r.out.trim();
  if (r.code !== 0 || token === "") throw new Error("reviewer token not found (Keychain service gibson-reviewer-token)");
  return token;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const prIndex = argv.indexOf("--pr");
  const pr = prIndex >= 0 ? Number(argv[prIndex + 1]) : undefined;
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) throw new Error("--pr needs a PR number");
  const root = resolve(".");
  const cfg = loadConfig(root);
  const io = realIo();
  const lane = new Lane(cfg, io, dryRun ? undefined : reviewerToken(io)); // token loaded once, before any read
  if (pr !== undefined || argv.includes("--once")) { lane.pass({ pr, dryRun }); return; }
  io.log(`watching ${cfg.repo} (reviewer=${cfg.login}, every 60s${dryRun ? ", dry-run" : ""}) — Ctrl-C or gibson/HALT to stop`);
  while (!halted(root, io.env)) {
    try { lane.pass({ dryRun }); } catch (e) { io.log(`pass failed (will retry next tick): ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  io.log("kill switch set — stopping");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
