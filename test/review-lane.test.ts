import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorVendor, capExceptionApplies, decide, halted, pickReviewer, publisherEnv, readEnv, requiredChecksGreen, roundCapReached, slotEvent, tierOf, verifyPublished } from "../scripts/review-lane.ts";
import type { CheckRun, PrFacts, Review } from "../scripts/review-lane.ts";

const caps = { A: 1, B: 2, C: 3, default: "A" };
const required = ["gate", "security-fast", "test-integrity", "DCO"];
const login = "ruzni-reviewer";
const head = "a".repeat(40);
const green: CheckRun[] = required.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success", started_at: "2026-11-04T10:00:00Z" }));
const claudeCommit = "feat: x\n\nSigned-off-by: A <a@x>\nAgent-Vendor: claude\n";
const base: PrFacts = { state: "OPEN", isDraft: false, baseRefName: "main", head, labels: ["tier-a"], runs: green, reviews: [], commitMessages: [claudeCommit] };
const opts = { login, required, caps, attempted: false };
const changes = (commit_id: string): Review => ({ user: { login }, state: "CHANGES_REQUESTED", commit_id });

test("author vendor: single trailer is accepted; missing, mixed or unknown are refused", () => {
  assert.deepEqual(authorVendor([claudeCommit, "fix: y\n\nAgent-Vendor: Claude\n"]), { vendor: "claude" });
  assert.ok("reason" in authorVendor(["chore: no trailer\n\nSigned-off-by: A <a@x>"]));
  assert.ok("reason" in authorVendor([claudeCommit, "x\n\nAgent-Vendor: codex\n"]));
  assert.ok("reason" in authorVendor(["x\n\nAgent-Vendor: someone\n"]));
});

test("reviewer is always a different vendor from the author (Law 5)", () => {
  assert.equal(pickReviewer("claude"), "codex");
  assert.equal(pickReviewer("grok"), "codex");
  assert.equal(pickReviewer("codex"), "claude");
});

test("required checks: missing, pending or failed latest run is not green", () => {
  assert.deepEqual(requiredChecksGreen(green, required), { ok: true });
  assert.equal(requiredChecksGreen(green.filter((r) => r.name !== "DCO"), required).ok, false);
  assert.equal(requiredChecksGreen([...green, { id: 99, name: "gate", status: "in_progress", conclusion: null, started_at: "2026-11-04T10:05:00Z" }], required).ok, false);
  assert.equal(requiredChecksGreen([...green, { id: 99, name: "gate", status: "completed", conclusion: "failure", started_at: "2026-11-04T10:05:00Z" }], required).ok, false);
  // latest is by start time, not by ID: a newer failure with a LOWER id still wins
  assert.equal(requiredChecksGreen([...green, { id: 0, name: "gate", status: "completed", conclusion: "failure", started_at: "2026-11-04T10:05:00Z" }], required).ok, false);
  // an older success with a higher id does not mask the newer state
  assert.equal(requiredChecksGreen([...green, { id: 99, name: "gate", status: "completed", conclusion: "failure", started_at: "2026-11-04T09:00:00Z" }], required).ok, true);
  // recency unknown → fail closed
  assert.equal(requiredChecksGreen([...green, { id: 99, name: "gate", status: "completed", conclusion: "success", started_at: null }], required).ok, false);
  assert.equal(requiredChecksGreen([...green, { id: 98, name: "gate", status: "completed", conclusion: "failure", started_at: "2026-11-04T10:00:00Z" }], required).ok, false);
});

test("round cap follows the Gibson caps per tier", () => {
  assert.equal(tierOf(["gibson", "tier-b"], caps), "B");
  assert.equal(tierOf([], caps), "A");
  assert.equal(roundCapReached([changes("x")], login, "A", caps), true);
  assert.equal(roundCapReached([changes("x")], login, "B", caps), false);
  assert.equal(roundCapReached([changes("x"), changes("y")], login, "B", caps), true);
});

test("decide: reviews a green, unreviewed, vendor-attributed PR with the other vendor", () => {
  assert.deepEqual(decide(base, opts), { action: "review", author: "claude", reviewer: "codex" });
});

test("decide: fails closed on every unmet condition", () => {
  const skip = (pr: Partial<PrFacts>, o: Partial<typeof opts> = {}) => decide({ ...base, ...pr }, { ...opts, ...o }).action;
  assert.equal(skip({ state: "MERGED" }), "skip");
  assert.equal(skip({ state: "CLOSED" }), "skip");
  assert.equal(skip({ isDraft: true }), "skip");
  assert.equal(skip({ baseRefName: "dev" }), "skip");
  assert.equal(skip({ reviews: [{ user: { login }, state: "APPROVED", commit_id: head }] }), "skip");
  assert.equal(skip({}, { attempted: true }), "skip");
  assert.equal(skip({ reviews: [changes("old")] }), "skip");
  assert.equal(skip({ runs: green.slice(1) }), "skip");
  assert.equal(skip({ commitMessages: ["no trailer"] }), "skip");
});

test("AC3: the lane never posts or merges itself; it reviews with second-opinion.sh and publishes with formal-review.sh", () => {
  const src = readFileSync(new URL("../scripts/review-lane.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /gh\s+pr\s+(review|merge)|"pr",\s*"(review|merge)"/);
  assert.doesNotMatch(code, /"(-X|--method)",\s*"(POST|PUT|PATCH|DELETE)"/i);
  assert.match(code, /second-opinion\.sh/);
  assert.match(code, /formal-review\.sh/);
  // the reviewing AI runs with the token-free environment; only the publisher gets the token
  assert.match(code, /run\("bash", args, readEnv\(process\.env, \[token\]\)\)/);
  assert.match(code, /publisherEnv\(process\.env, token\)/);
  assert.doesNotMatch(code, /GIBSON_FORMAL_REVIEW:\s*"1"/);
});

test("verdict: the Gibson slot-authority rule (#290) decides the formal event", () => {
  assert.equal(slotEvent("second-opinion.sh: slot:codex state:approve"), "approve");
  assert.equal(slotEvent("slot:codex state:approve\nslot:grok state:request-changes"), "request-changes");
  assert.equal(slotEvent("slot:codex state:approve\nslot:grok state:no-verdict"), undefined);
  assert.equal(slotEvent("no slot lines at all"), undefined);
});

test("AC4: gh reads and the reviewing AI run without the reviewer token; only the publisher holds it", () => {
  const env = readEnv({ GH_REVIEWER_TOKEN: "secret", GIBSON_REVIEWER_TOKEN: "secret2", GIBSON_FORMAL_REVIEW: "1", GH_TOKEN: "operator", PATH: "/bin" });
  assert.equal(env.GH_REVIEWER_TOKEN, undefined);
  assert.equal(env.GIBSON_REVIEWER_TOKEN, undefined);
  assert.equal(env.GIBSON_FORMAL_REVIEW, undefined);
  // by value: the reviewer token is removed whatever variable holds it (e.g. GH_TOKEN)
  const byValue = readEnv({ GH_TOKEN: "tok-123", OTHER: "x tok-123 y", PATH: "/bin" }, ["tok-123"]);
  assert.deepEqual(byValue, { PATH: "/bin" });
  assert.equal(readEnv({ GH_TOKEN: "operator" }, [""]).GH_TOKEN, "operator");
  const pub = publisherEnv({ GIBSON_REVIEWER_TOKEN: "stale", GH_TOKEN: "fresh", PATH: "/bin" }, "fresh");
  assert.equal(pub.GH_TOKEN, undefined);
  assert.equal(pub.GH_REVIEWER_TOKEN, "fresh");
  assert.equal(pub.GIBSON_REVIEWER_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, "operator");
  assert.equal(env.PATH, "/bin");
});

test("AC5: the Gibson kill switch (gibson/HALT or GIBSON_HALT=1) stops the lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-lane-"));
  try {
    assert.equal(halted(dir, {}), false);
    assert.equal(halted(dir, { GIBSON_HALT: "1" }), true);
    mkdirSync(join(dir, "gibson"));
    writeFileSync(join(dir, "gibson", "HALT"), "");
    assert.equal(halted(dir, {}), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC1: every GitHub list the decision reads is fully paginated", () => {
  const src = readFileSync(new URL("../scripts/review-lane.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /"pr",\s*"list"/, "open-PR discovery must not use the capped gh pr list");
  for (const list of ["check-runs", "/reviews", "/commits?", "/pulls?state=open"]) {
    const calls = src.split("\n").filter((l) => l.includes(list) && l.includes("repos/"));
    assert.ok(calls.length > 0, `no read of ${list}`);
    for (const line of calls) assert.match(line, /ghPages</, `unpaginated read: ${line.trim()}`);
  }
});

test("publication: the posted review is read back and verified (identity, head, state, new)", () => {
  const since = "2026-11-04T10:00:00Z";
  const ok: Review = { id: 7, user: { login }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-04T10:01:00Z" };
  assert.deepEqual(verifyPublished([ok], login, head, "approve", since), { ok: true, id: 7 });
  assert.equal(verifyPublished([], login, head, "approve", since).ok, false); // nothing posted: uncertain
  assert.equal(verifyPublished([{ ...ok, state: "CHANGES_REQUESTED" }], login, head, "approve", since).ok, false);
  assert.equal(verifyPublished([{ ...ok, user: { login: "someone-else" } }], login, head, "approve", since).ok, false);
  assert.equal(verifyPublished([{ ...ok, commit_id: "b".repeat(40) }], login, head, "approve", since).ok, false);
  assert.equal(verifyPublished([{ ...ok, submitted_at: "2026-11-04T09:00:00Z" }], login, head, "approve", since).ok, false); // old review
  assert.equal(verifyPublished([ok, { ...ok, id: 8 }], login, head, "approve", since).ok, false); // duplicate: reconcile
});

test("captain's cap exception is bounded to one exact PR and head", () => {
  const capped = { reviews: [changes("x"), changes("y"), changes("z")], labels: ["tier-c"] };
  assert.equal(decide({ ...base, ...capped }, opts).action, "skip");
  assert.equal(decide({ ...base, ...capped }, { ...opts, capException: true }).action, "review");
  assert.equal(capExceptionApplies(`19@${head}`, 19, head), true);
  assert.equal(capExceptionApplies(`19@${head}`, 19, "b".repeat(40)), false); // a later push is capped again
  assert.equal(capExceptionApplies(`20@${head}`, 19, head), false);
  assert.equal(capExceptionApplies("19@*", 19, head), false);
  assert.equal(capExceptionApplies(undefined, 19, head), false);
  // the exception never skips the other conditions
  assert.equal(decide({ ...base, ...capped, runs: green.slice(1) }, { ...opts, capException: true }).action, "skip");
});

test("--dry-run is read-only: the state directory is created only when a real review starts", () => {
  const src = readFileSync(new URL("../scripts/review-lane.ts", import.meta.url), "utf8");
  const load = src.slice(src.indexOf("function loadConfig"), src.indexOf("function reviewerToken"));
  assert.doesNotMatch(load, /mkdirSync|writeFileSync|appendFileSync/);
  const reviewFn = src.slice(src.indexOf("function review("), src.indexOf("function pass("));
  assert.match(reviewFn, /mkdirSync\(cfg\.stateDir/);
});
