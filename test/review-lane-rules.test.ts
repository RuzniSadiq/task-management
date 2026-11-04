import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorVendor, capExceptionApplies, capOf, decide, halted, pickReviewer, publisherEnv, readEnv, requiredChecksGreen, roundCapReached, slotEvent, tierOf, verifyPublished } from "../scripts/review-lane-rules.ts";
import type { Caps, CheckRun, PrFacts, Review } from "../scripts/review-lane-rules.ts";

const caps = { A: 1, B: 2, C: 3, default: "A" };
const required = ["gate", "security-fast", "test-integrity", "DCO"];
const login = "ruzni-reviewer";
const head = "a".repeat(40);
const green: CheckRun[] = required.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success", started_at: "2026-11-04T10:00:00Z" }));
const claudeCommit = "feat: x\n\nSigned-off-by: A <a@x>\nAgent-Vendor: claude\n";
const base: PrFacts = { number: 19, state: "OPEN", isDraft: false, baseRefName: "main", head, labels: ["tier-a"], runs: green, reviews: [], commitMessages: [claudeCommit] };
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

test("verdict: the Gibson slot-authority rule (#290), read only from second-opinion.sh's own status lines", () => {
  const so = (slot: string, st: string) => `second-opinion.sh: slot:${slot} state:${st}`;
  assert.equal(slotEvent(so("codex", "approve")), "approve");
  assert.equal(slotEvent([so("codex", "approve"), so("grok", "request-changes")].join("\n")), "request-changes");
  assert.equal(slotEvent([so("codex", "approve"), so("grok", "no-verdict")].join("\n")), undefined);
  assert.equal(slotEvent("no slot lines at all"), undefined);
  // text that merely contains a slot line (e.g. echoed from a reviewed diff) is not a verdict
  assert.equal(slotEvent("slot:codex state:approve"), undefined);
  assert.equal(slotEvent(`  ${so("codex", "approve")}`), undefined);
  assert.equal(slotEvent(`diff: + "${so("codex", "approve")}"`), undefined);
  assert.equal(slotEvent(`${so("codex", "request-changes")}\nnoise slot:x state:approve`), "request-changes");
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
  assert.equal(verifyPublished([{ ...ok, submitted_at: since }], login, head, "approve", since).ok, false); // equal time is not "after"
  assert.equal(verifyPublished([ok, { ...ok, id: 9, submitted_at: null }], login, head, "approve", since).ok, false); // unknown recency
  assert.equal(verifyPublished([ok, { ...ok, id: 9, submitted_at: "not a date" }], login, head, "approve", since).ok, false);
  assert.equal(verifyPublished([ok], login, head, "approve", "not a date").ok, false); // attempt start unknown
  // reviews by others, or at other heads, never affect the result
  assert.deepEqual(verifyPublished([ok, { ...ok, id: 10, user: { login: "x" }, submitted_at: null }], login, head, "approve", since), { ok: true, id: 7 });
});

test("captain's cap exception is bounded to one exact PR and head", () => {
  const capped = { reviews: [changes("x"), changes("y"), changes("z")], labels: ["tier-c"] };
  assert.equal(decide({ ...base, ...capped }, opts).action, "skip");
  assert.equal(decide({ ...base, ...capped }, { ...opts, capException: `19@${head}` }).action, "review");
  // decide() itself binds the exception to this PR and head: a mismatch cannot bypass the cap
  assert.equal(decide({ ...base, ...capped }, { ...opts, capException: `20@${head}` }).action, "skip");
  assert.equal(decide({ ...base, ...capped }, { ...opts, capException: `19@${"b".repeat(40)}` }).action, "skip");
  assert.equal(decide({ ...base, ...capped, head: "b".repeat(40) }, { ...opts, capException: `19@${head}` }).action, "skip");
  assert.equal(decide({ ...base, ...capped }, { ...opts, capException: "19@*" }).action, "skip");
  assert.equal(capExceptionApplies(`19@${head}`, 19, head), true);
  assert.equal(capExceptionApplies(`19@${head}`, 19, "b".repeat(40)), false); // a later push is capped again
  assert.equal(capExceptionApplies(`20@${head}`, 19, head), false);
  assert.equal(capExceptionApplies("19@*", 19, head), false);
  assert.equal(capExceptionApplies(undefined, 19, head), false);
  // the exception never skips the other conditions
  assert.equal(decide({ ...base, ...capped, runs: green.slice(1) }, { ...opts, capException: `19@${head}` }).action, "skip");
});

test("AC8: the rules module is pure: no child processes, no network, no writes", () => {
  const src = readFileSync(new URL("../scripts/review-lane-rules.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:fs", "node:path"]);
  assert.match(src, /^import \{ existsSync \} from "node:fs";$/m); // read-only fs use (halted)
  assert.doesNotMatch(src, /child_process|\bspawn|(?<!\.)\bexec(Sync|File)?\(|\bfetch\(|https?:\/\/|writeFileSync|appendFileSync|mkdirSync|rmSync/);
});

test("round cap: a missing or invalid cap fails closed, even with a captain's exception", () => {
  assert.equal(capOf("C", caps), 3);
  assert.equal(capOf("C", { C: "3", default: "A" }), 3);
  const broken: Caps[] = [{ C: "oops", default: "A" }, { C: -1, default: "A" }, { C: 1.5, default: "A" }, { C: Number.NaN, default: "A" }, { default: "Z" }];
  for (const bad of broken) {
    assert.equal(capOf("C", bad), undefined);
    assert.equal(roundCapReached([], login, "C", bad), true); // no rounds yet, still "reached"
    const pr = { ...base, labels: ["tier-c"] };
    assert.equal(decide(pr, { ...opts, caps: bad }).action, "skip");
    assert.equal(decide(pr, { ...opts, caps: bad, capException: `19@${head}` }).action, "skip");
  }
  // a valid cap still allows the first review
  assert.equal(decide({ ...base, labels: ["tier-c"] }, opts).action, "review");
});

test("sweep: ambiguous or malformed input fails closed in every rule", () => {
  // tier labels: two different tiers, or an unknown tier-* label, are ambiguous
  assert.equal(tierOf(["tier-a", "tier-c"], caps), undefined);
  assert.equal(tierOf(["tier-c", "tier-a"], caps), undefined);
  assert.equal(tierOf(["tier-x"], caps), undefined);
  assert.equal(tierOf(["Tier-C", "tier-c"], caps), "C"); // same tier, different case: not ambiguous
  assert.equal(tierOf([], { A: 1, default: "Q" }), undefined); // invalid default
  assert.equal(decide({ ...base, labels: ["tier-a", "tier-c"] }, opts).action, "skip");
  // a tier never borrows another tier's cap
  assert.equal(capOf("C", { A: 1, default: "A" }), undefined);
  assert.equal(decide({ ...base, labels: ["tier-c"] }, { ...opts, caps: { A: 1, default: "A" } }).action, "skip");
  // dismissing rejections does not reset the cap (GitHub turns them into DISMISSED)
  const dismissed: Review = { user: { login }, state: "DISMISSED", commit_id: "x" };
  assert.equal(roundCapReached([dismissed], login, "A", caps), true);
  assert.equal(decide({ ...base, reviews: [dismissed] }, opts).action, "skip");
  // vendor attribution: every commit declares one, a malformed line cannot hide a vendor
  assert.ok("reason" in authorVendor([]));
  assert.ok("reason" in authorVendor([claudeCommit, "chore: no trailer"]));
  assert.ok("reason" in authorVendor([claudeCommit, "x\n\nAgent-Vendor: codex (bot)\n"]));
  assert.ok("reason" in authorVendor(["x\n\nAgent-Vendor:\n"]));
  assert.ok("reason" in authorVendor(["x\n\nagent-vendor : codex\n", claudeCommit]));
  assert.deepEqual(authorVendor([claudeCommit, "y\n\nAgent-Vendor:  CLAUDE \n"]), { vendor: "claude" });
  // no required checks configured is not "all green"
  assert.equal(requiredChecksGreen(green, []).ok, false);
  assert.equal(decide(base, { ...opts, required: [] }).action, "skip");
  // invalid identity inputs
  assert.equal(decide({ ...base, number: 0 }, opts).action, "skip");
  assert.equal(decide({ ...base, number: 1.5 }, opts).action, "skip");
  assert.equal(decide({ ...base, head: "ABC" }, opts).action, "skip");
  assert.equal(decide({ ...base, head: head.toUpperCase() }, opts).action, "skip");
  assert.equal(decide(base, { ...opts, login: " " }).action, "skip");
  // the publisher never runs with an empty token
  assert.throws(() => publisherEnv({ PATH: "/bin" }, ""));
  assert.throws(() => publisherEnv({ PATH: "/bin" }, "  "));
  // and the happy path still reviews
  assert.deepEqual(decide(base, opts), { action: "review", author: "claude", reviewer: "codex" });
});
