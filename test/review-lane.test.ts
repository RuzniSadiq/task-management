import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GIBSON_BLOCKER_RULE, Lane } from "../scripts/review-lane.ts";
import type { Config, Io } from "../scripts/review-lane.ts";
import type { Review } from "../scripts/review-lane-rules.ts";

const TOKEN = "tok-REVIEWER-123";
const head = "a".repeat(40);
const base = "b".repeat(40);
const root = "/repo";
const cfg: Config = { repo: "o/r", login: "ruzni-reviewer", required: ["gate", "DCO"], caps: { A: 1, B: 2, C: 3, default: "A" }, gibson: "/gibson", root };
const greenRuns = cfg.required.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success", started_at: "2026-11-04T10:00:00Z" }));

interface Scenario {
  prs?: number[]; headNow?: string[]; wtHead?: string; wtBase?: string; fetchCode?: number; addCode?: number;
  reviewerOut?: string; postReview?: boolean; commentDuringReview?: boolean; postSameSecond?: boolean; haltDuringReview?: boolean; haltDuringSetup?: boolean; readBackFails?: number; failView?: number; failViewAt?: number; baseNow?: string[]; haltAtPublish?: boolean; envExtra?: NodeJS.ProcessEnv;
}

/** A fake Io that records everything the runner does. */
function fake(sc: Scenario = {}) {
  const files = new Map<string, string>();
  const events: string[] = [];
  const ghCalls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runs: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const reviews: Review[] = [];
  const locks = new Set<string>();
  let clock = Date.parse("2026-11-04T11:00:00Z");
  let views = 0;
  let readBackFails = sc.readBackFails ?? 0;
  const io: Io = {
    env: { PATH: "/bin", GH_TOKEN: TOKEN, ...sc.envExtra }, // the reviewer token is (mis)placed in GH_TOKEN on purpose
    gh(args, env) {
      ghCalls.push({ args, env });
      if (args[0] === "pr" && args[1] === "view") {
        const n = Number(args[2]);
        if (sc.failView === n) throw new Error("gh pr view failed");
        const at = views++;
        if (sc.failViewAt === at) throw new Error("gh pr view failed: HTTP 502");
        if (sc.haltAtPublish === true && at === 1) io.env.GIBSON_HALT = "1"; // pulled during the pre-publication recheck
        const h = sc.headNow?.[at] ?? head;
        const b = sc.baseNow?.[at] ?? base;
        return JSON.stringify({ number: n, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: b, headRefOid: h,
          title: "t", body: "Closes #5", labels: [{ name: "tier-a" }], closingIssuesReferences: [{ number: 5 }] });
      }
      if (args[0] === "issue") return JSON.stringify({ title: "issue", body: "AC1: something" });
      const path = args[3] ?? "";
      if (path.includes("pulls?state=open")) return JSON.stringify([(sc.prs ?? [7]).map((number) => ({ number }))]);
      if (path.includes("/check-runs")) return JSON.stringify([{ check_runs: greenRuns }]);
      if (path.includes("/commits?")) return JSON.stringify([[{ commit: { message: "x\n\nAgent-Vendor: claude\n" } }]]);
      if (path.includes("/reviews")) {
        if (events.includes("formal-review") && readBackFails > 0) { readBackFails--; throw new Error("read-back failed"); }
        return JSON.stringify([reviews]);
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
    run(cmd, args, env) {
      runs.push({ cmd, args, env });
      if (cmd === "git" && args.includes("fetch")) { events.push("fetch"); return { code: sc.fetchCode ?? 0, out: "", err: "fetch err" }; }
      if (cmd === "git" && args.includes("add")) { events.push("worktree-add"); if (sc.haltDuringSetup === true) io.env.GIBSON_HALT = "1"; return { code: sc.addCode ?? 0, out: "", err: "add err" }; }
      if (cmd === "git" && args.includes("remove")) { events.push("worktree-remove"); return { code: 0, out: "", err: "" }; }
      if (cmd === "git" && args.includes("HEAD")) return { code: 0, out: `${sc.wtHead ?? head}\n`, err: "" };
      if (cmd === "git" && args.includes("origin/main")) return { code: 0, out: `${sc.wtBase ?? base}\n`, err: "" };
      if (cmd === "bash") {
        events.push("reviewer");
        if (sc.haltDuringReview === true) io.env.GIBSON_HALT = "1"; // the owner pulls the kill switch mid-review
        // an unrelated same-identity review appearing while the review runs (before publication)
        if (sc.commentDuringReview === true) reviews.push({ id: 50, user: { login: cfg.login }, state: "COMMENTED", commit_id: head, submitted_at: new Date(clock).toISOString() });
        return { code: 0, out: "", err: sc.reviewerOut ?? "second-opinion.sh: slot:codex state:approve\n" }; }
      if (cmd.endsWith("formal-review.sh")) {
        events.push("formal-review");
        const at = sc.postSameSecond === true ? new Date(Math.floor(clock / 1000) * 1000).toISOString() : new Date(clock + 500).toISOString();
        if (sc.postReview !== false) reviews.push({ id: 99, user: { login: cfg.login }, state: "APPROVED", commit_id: head, submitted_at: at });
        return { code: 0, out: "", err: "" };
      }
      throw new Error(`unexpected run ${cmd} ${args.join(" ")}`);
    },
    read: (p) => files.get(p),
    write(p, t) { files.set(p, t); events.push(`write:${p.split("/").pop() ?? ""}`); },
    append(p, t) { files.set(p, (files.get(p) ?? "") + t); },
    mkdir() { events.push("mkdir"); },
    lock(p) { if (locks.has(p)) return false; locks.add(p); return true; },
    unlock(p) { locks.delete(p); },
    now() { clock += 1000; return new Date(clock).toISOString(); },
    log(m) { events.push(`log:${m}`); },
  };
  return { io, files, events, ghCalls, runs, reviews, locks };
}

const state = (name: string) => join(root, "gibson", "review-lane", name);
const attempts = (f: ReturnType<typeof fake>) => JSON.parse(f.files.get(state("attempted.json")) ?? "[]") as string[];
const pubs = (f: ReturnType<typeof fake>) => JSON.parse(f.files.get(state("publications.json")) ?? "[]") as { status: string }[];
const count = (f: ReturnType<typeof fake>, e: string) => f.events.filter((x) => x === e).length;

test("happy path: reviews, records, publishes once through formal-review.sh, reads back", () => {
  const f = fake();
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(count(f, "formal-review"), 1);
  assert.deepEqual(attempts(f), [`7@${head}`]);
  assert.equal(pubs(f)[0]?.status, "published:99");
  assert.ok(f.events.some((e) => e.includes("approve (review 99)")));
  assert.equal(count(f, "worktree-remove"), 1);
});

test("AC1: never posts, merges or edits through gh; publication only via formal-review.sh", () => {
  const f = fake();
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  for (const c of f.ghCalls) {
    assert.ok(!(c.args[0] === "pr" && ["review", "merge", "edit", "comment", "close"].includes(c.args[1] ?? "")), c.args.join(" "));
    assert.ok(!c.args.some((a) => /^(-X|--method)$/.test(a)), c.args.join(" "));
  }
  const publishers = f.runs.filter((r) => r.cmd.endsWith("formal-review.sh"));
  assert.equal(publishers.length, 1);
  assert.deepEqual(publishers[0]?.args.slice(-2), ["--commit", head]);
});

test("AC2/AC3: the reviewer token reaches only formal-review.sh — never gh, git or the reviewing AI", () => {
  const f = fake();
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  const leaks = (env: NodeJS.ProcessEnv) => Object.values(env).some((v) => v?.includes(TOKEN) === true);
  for (const c of f.ghCalls) assert.equal(leaks(c.env), false, `gh ${c.args.join(" ")}`);
  for (const r of f.runs.filter((x) => !x.cmd.endsWith("formal-review.sh"))) assert.equal(leaks(r.env), false, `${r.cmd} ${r.args.join(" ")}`);
  assert.ok(f.ghCalls.some((c) => c.args.includes("/reviews") || (c.args[3] ?? "").includes("/reviews")), "a read happened after publication");
  const pub = f.runs.find((r) => r.cmd.endsWith("formal-review.sh"));
  assert.equal(pub?.env.GH_REVIEWER_TOKEN, TOKEN);
  assert.equal(pub?.env.GH_TOKEN, undefined); // the misplaced copy is stripped by value
  const reviewer = f.runs.find((r) => r.cmd === "bash");
  assert.equal(reviewer?.env.GIBSON_FORMAL_REVIEW, undefined);
});

test("AC4: a checked-out head or base that differs from the PR range aborts before the reviewer, without consuming the attempt", () => {
  for (const sc of [{ wtHead: "c".repeat(40) }, { wtBase: "d".repeat(40) }]) {
    const f = fake(sc);
    new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
    assert.equal(count(f, "reviewer"), 0);
    assert.deepEqual(attempts(f), []);
    assert.equal(count(f, "worktree-remove"), 1); // created, so cleaned up
  }
  // and the reviewer is told the exact captured base, not a moving ref
  const ok = fake();
  new Lane(cfg, ok.io, TOKEN).pass({ dryRun: false });
  const args = ok.runs.find((r) => r.cmd === "bash")?.args ?? [];
  assert.equal(args[args.indexOf("--base") + 1], base);
});

test("AC5: setup failures never consume the attempt; cleanup only for a worktree that was created", () => {
  const fetchFail = fake({ fetchCode: 1 });
  new Lane(cfg, fetchFail.io, TOKEN).pass({ dryRun: false });
  assert.deepEqual(attempts(fetchFail), []);
  assert.equal(count(fetchFail, "worktree-add"), 0);
  assert.equal(count(fetchFail, "worktree-remove"), 0);
  const addFail = fake({ addCode: 1 });
  new Lane(cfg, addFail.io, TOKEN).pass({ dryRun: false });
  assert.deepEqual(attempts(addFail), []);
  assert.equal(count(addFail, "worktree-remove"), 0);
  // the attempt is recorded only after the reviewer ran
  const ok = fake();
  new Lane(cfg, ok.io, TOKEN).pass({ dryRun: false });
  assert.ok(ok.events.indexOf("reviewer") < ok.events.indexOf("write:attempted.json"));
});

test("AC5: a run with no verdict allows exactly one retry", () => {
  const f = fake({ reviewerOut: "second-opinion.sh: slot:codex state:no-verdict\n" });
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  assert.equal(lane.attempted(7, head), false); // one retry left
  lane.pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 2);
  assert.equal(lane.attempted(7, head), true);
  lane.pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 2); // no third run
  assert.equal(count(f, "formal-review"), 0);
});

test("AC6: the publication is recorded before formal-review.sh; an uncertain one is reconciled, never published twice", () => {
  const f = fake({ readBackFails: 1 });
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  assert.ok(f.events.indexOf("write:publications.json") < f.events.indexOf("formal-review"));
  assert.equal(pubs(f)[0]?.status, "pending"); // read-back failed: still pending, not lost
  lane.pass({ dryRun: false }); // next pass reconciles first
  assert.equal(pubs(f)[0]?.status, "published:99");
  assert.equal(count(f, "formal-review"), 1);
});

test("AC6: a post that never landed is recorded as uncertain and not retried", () => {
  const f = fake({ postReview: false });
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  lane.pass({ dryRun: false });
  assert.match(pubs(f)[0]?.status ?? "", /^uncertain/);
  assert.equal(count(f, "formal-review"), 1);
});

test("AC7: a head that moved during the review is not published", () => {
  const f = fake({ headNow: [head, "e".repeat(40)] }); // first view decides; the pre-publication view sees a new head
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 1);
  assert.equal(count(f, "formal-review"), 0);
  assert.ok(f.events.some((e) => e.includes("range moved during review")));
});

test("AC8: every GitHub list read, including discovery, is paginated", () => {
  const f = fake();
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  const lists = f.ghCalls.filter((c) => c.args[0] === "api");
  assert.ok(lists.some((c) => (c.args[3] ?? "").includes("pulls?state=open")));
  for (const c of lists) assert.deepEqual(c.args.slice(0, 3), ["api", "--paginate", "--slurp"]);
  assert.equal(f.ghCalls.some((c) => c.args[0] === "pr" && c.args[1] === "list"), false);
});

test("AC9: --dry-run reads only: no token, no writes, no lock, no reviewer", () => {
  const f = fake();
  new Lane(cfg, f.io, undefined).pass({ dryRun: true });
  assert.equal(f.files.size, 0);
  assert.equal(count(f, "mkdir"), 0);
  assert.equal(f.locks.size, 0);
  assert.equal(f.runs.length, 0);
  assert.ok(f.events.some((e) => e.includes("ready, author=claude → reviewer=codex")));
});

test("AC10: the kill switch stops the pass before any GitHub read", () => {
  const f = fake({ envExtra: { GIBSON_HALT: "1" } });
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(f.ghCalls.length, 0);
  assert.ok(f.events.some((e) => e.includes("kill switch")));
});

test("AC12: the review task carries the Gibson's blocker rule word for word", () => {
  assert.equal(GIBSON_BLOCKER_RULE, "A blocker names a reachable trigger, wrong outcome and file:line or unmet acceptance criterion. "
    + "Nits, speculative risks and optional improvements are notes; a real defect is still blocking when labeled \"Minor\".");
  const f = fake();
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  const task = [...f.files.entries()].find(([k]) => k.endsWith(".task.md"))?.[1] ?? "";
  assert.ok(task.includes(GIBSON_BLOCKER_RULE));
  assert.ok(task.includes("Request changes only for blockers"));
  assert.ok(task.includes("## Issue #5: issue (acceptance criteria)"));
  assert.ok(task.trimEnd().endsWith('no bold, no other Markdown on that line.'));
});

test("single-flight: a pass is skipped while another lane holds the lock", () => {
  const f = fake();
  f.locks.add(state("lane.lock"));
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 0);
  assert.ok(f.events.some((e) => e.includes("holds the lock")));
});

test("one PR's error never blocks the others", () => {
  const f = fake({ prs: [6, 7], failView: 6 });
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.ok(f.events.some((e) => e.includes("PR #6 — skipped: error")));
  assert.equal(count(f, "formal-review"), 1); // PR #7 still reviewed
  assert.equal(f.locks.size, 0); // and the lock is released
});

test("AC5: a reviewer that never started (missing script) consumes no attempt, however often it fails", () => {
  const f = fake({ reviewerOut: "bash: /gibson/scripts/lib/wall-timeout.sh: No such file or directory\n" });
  const lane = new Lane(cfg, f.io, TOKEN);
  for (let i = 0; i < 3; i++) lane.pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 3); // retried every pass, never locked out
  assert.deepEqual(attempts(f), []);
  assert.equal(lane.attempted(7, head), false);
  assert.ok(f.events.some((e) => e.includes("reviewer did not start")));
  // whereas a reviewer that ran but gave no verdict does consume (one retry)
  const nv = fake({ reviewerOut: "second-opinion.sh: slot:codex state:no-verdict\n" });
  new Lane(cfg, nv.io, TOKEN).pass({ dryRun: false });
  assert.deepEqual(attempts(nv), [`7@${head}#no-verdict`]);
});

test("AC6: the read-back window opens at publication, not at the start of the attempt", () => {
  // a same-identity review that appeared during the review must not be counted as ours
  const f = fake({ commentDuringReview: true });
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(pubs(f)[0]?.status, "published:99");
  // and our own review, stamped within the same whole second as the cutoff, is still recognised
  const g = fake({ postSameSecond: true });
  new Lane(cfg, g.io, TOKEN).pass({ dryRun: false });
  assert.equal(pubs(g)[0]?.status, "published:99");
});

test("AC10: a kill switch pulled during the review stops publication, and the attempt is not consumed", () => {
  const f = fake({ haltDuringReview: true });
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 1);
  assert.equal(count(f, "formal-review"), 0); // nothing published after the switch
  assert.deepEqual(pubs(f), []);
  assert.deepEqual(attempts(f), []); // so the review is redone once the switch is off
  assert.ok(f.events.some((e) => e.includes("halted during the review")));
  assert.equal(count(f, "worktree-remove"), 1); // and the worktree is still cleaned up
  // once released, the same head is reviewed and published normally
  delete f.io.env.GIBSON_HALT;
  const g = fake();
  new Lane(cfg, g.io, TOKEN).pass({ dryRun: false });
  assert.equal(count(g, "formal-review"), 1);
});

test("AC10: a kill switch pulled during setup stops the reviewer from starting", () => {
  const f = fake({ haltDuringSetup: true });
  new Lane(cfg, f.io, TOKEN).pass({ dryRun: false });
  assert.equal(count(f, "reviewer"), 0);
  assert.deepEqual(attempts(f), []);
  assert.ok(f.events.some((e) => e.includes("halted before the reviewer started")));
  assert.equal(count(f, "worktree-remove"), 1);
});

test("AC5: a verdict that never reached publication (transient error, base moved) is retried once, not lost", () => {
  // a GitHub error in the pre-publication recheck must not lock the head out with no review
  const f = fake({ failViewAt: 1 }); // view 0 decides; view 1 is the pre-publication recheck
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  assert.equal(count(f, "formal-review"), 0);
  assert.equal(lane.attempted(7, head), false); // one retry left
  lane.pass({ dryRun: false }); // the error was transient
  assert.equal(count(f, "reviewer"), 2);
  assert.equal(count(f, "formal-review"), 1);
  assert.equal(pubs(f)[0]?.status, "published:99");
  // the base moved during the review at the same head: re-review against the new base
  const g = fake({ baseNow: [base, "d".repeat(40)] });
  const lane2 = new Lane(cfg, g.io, TOKEN);
  lane2.pass({ dryRun: false });
  assert.equal(count(g, "formal-review"), 0);
  assert.equal(lane2.attempted(7, head), false);
  // a persistent failure is bounded: two runs, then no more
  const h = fake({ baseNow: [base, "d".repeat(40), base, "d".repeat(40), base] });
  const lane3 = new Lane(cfg, h.io, TOKEN);
  for (let i = 0; i < 3; i++) lane3.pass({ dryRun: false });
  assert.equal(count(h, "reviewer"), 2);
  assert.equal(count(h, "formal-review"), 0);
});

test("AC10: a kill switch pulled during the pre-publication recheck stops publication without consuming the attempt", () => {
  const f = fake({ haltAtPublish: true });
  const lane = new Lane(cfg, f.io, TOKEN);
  lane.pass({ dryRun: false });
  assert.equal(count(f, "formal-review"), 0);
  assert.deepEqual(pubs(f), []);
  assert.deepEqual(attempts(f), []);
  assert.ok(f.events.some((e) => e.includes("not published: kill switch set")));
});
