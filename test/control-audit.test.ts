import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, audit, directPushFindingTitle, parseConfig, prFindingTitle, protectionDrift, protectionFindingTitle, toJsonl } from "../scripts/control-audit.ts";
import type { Audit, Commit, ControlRecord, DeliveryConfig, Gh, Issue, PrInfo, PrReview, Protection } from "../scripts/control-audit.ts";
import type { CheckRun } from "../scripts/review-lane-rules.ts";

const cfg: DeliveryConfig = { defaultBranch: "main", requiredContexts: ["gate", "security-fast", "test-integrity", "DCO"], reviewerLogin: "ruzni-reviewer" };
const run = { url: "https://github.com/o/r/actions/runs/9", attempt: "1" };
const opts = { repo: "o/r", run, now: () => "2026-11-05T00:00:00.000Z", since: "2026-11-01T00:00:00Z", config: cfg };

const GOOD_PROTECTION: Protection = {
  required_status_checks: { strict: true, contexts: [...cfg.requiredContexts] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

const msg = (subject: string, vendor = "claude"): string => `${subject}\n\nAgent-Vendor: ${vendor}\n\nSigned-off-by: A Dev <dev@example.com>`;
const green = (name: string, at = "2026-11-02T10:00:00Z"): CheckRun => ({ id: 1, name, status: "completed", conclusion: "success", started_at: at });

interface Fixture {
  info: PrInfo;
  commits: Commit[];
  reviews: PrReview[];
  runs: CheckRun[];
}

/** A PR that meets every control; each test breaks exactly one thing. */
function goodPr(n: number, over: Partial<Fixture> = {}): Fixture {
  const head = `${String(n).padStart(2, "0")}${"a".repeat(38)}`;
  return {
    info: { number: n, title: `change ${n}`, url: `https://github.com/o/r/pull/${n}`, mergedAt: "2026-11-03T00:00:00Z", head },
    commits: [{ sha: head, message: msg(`feat: ${n}`) }],
    reviews: [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: head, body: "## Second opinion — codex\n\n1. VERDICT: APPROVE" }],
    runs: cfg.requiredContexts.map((c) => green(c)),
    ...over,
  };
}

interface World {
  prs?: Fixture[];
  protection?: Protection | Error;
  direct?: Commit[];
  open?: Issue[];
  mainCommits?: Commit[];
  failOn?: Set<string>;
}

function fakeGh(w: World) {
  const prs = w.prs ?? [];
  const open: Issue[] = [...(w.open ?? [])];
  const created: { title: string; body: string }[] = [];
  const updated: { issue: number; body: string }[] = [];
  let labelEnsured = 0;
  let next = 200;
  const byPr = (n: number): Fixture => { const f = prs.find((p) => p.info.number === n); if (f === undefined) throw new Error(`no PR ${n}`); return f; };
  const bad = (what: string): void => { if (w.failOn?.has(what)) throw new Error(`HTTP 502 (${what})`); };
  const mainCommits = w.mainCommits ?? [...prs.map((p) => ({ sha: p.info.head, message: "squash" })), ...(w.direct ?? [])];
  const gh: Gh = {
    mergedPrs: () => { bad("mergedPrs"); return prs.map((p) => p.info); },
    commits: (n) => { bad("commits"); return byPr(n).commits; },
    reviews: (n) => { bad("reviews"); return byPr(n).reviews; },
    checkRuns: (sha) => { bad("checkRuns"); const f = prs.find((p) => p.info.head === sha); if (f === undefined) throw new Error("no head"); return f.runs; },
    protection: () => { bad("protection"); const p = w.protection ?? GOOD_PROTECTION; if (p instanceof Error) throw p; return p; },
    branchCommits: () => { bad("branchCommits"); return mainCommits; },
    mergedPrsOf: (sha) => { bad("mergedPrsOf"); return prs.filter((p) => p.info.head === sha).map((p) => p.info.number); },
    ensureLabel: () => { labelEnsured++; },
    openFindings: () => { bad("openFindings"); return open; },
    createIssue: (title, body) => { bad("createIssue"); created.push({ title, body }); const number = next++; open.push({ number, title }); return number; },
    updateIssue: (issue, body) => { updated.push({ issue, body }); },
  };
  return { gh, created, updated, open, labels: () => labelEnsured };
}

const failed = (a: Audit): ControlRecord[] => a.records.filter((r) => r.result === "fail");
const checksFailed = (a: Audit, pr: number): string[] => failed(a).filter((r) => r.subject.pr === pr).map((r) => r.control.check);

test("a PR that meets every control passes all six checks, protection and no-direct-push; no issue is written", () => {
  const f = fakeGh({ prs: [goodPr(1)] });
  const a = audit(f.gh, opts);
  assert.equal(a.result, "pass");
  assert.deepEqual(failed(a), []);
  assert.deepEqual(a.records.filter((r) => r.subject.pr === 1).map((r) => r.control.check).sort(),
    ["agent-vendor-trailer", "dco-signoff", "independent-approval-at-head", "merged-via-pr", "required-checks-green", "vendor-separation"]);
  assert.equal(a.records.length, 6 + 1 + 1);
  assert.deepEqual(f.created, []);
  assert.deepEqual(a.findings, []);
});

test("evidence is JSONL of the v1 schema with control id, catalog, version, result and evidence refs", () => {
  const a = audit(fakeGh({ prs: [goodPr(1)] }).gh, opts);
  const lines = toJsonl(a.records).trimEnd().split("\n");
  assert.equal(lines.length, a.records.length);
  for (const l of lines) {
    const r = JSON.parse(l) as ControlRecord;
    assert.equal(r.schema, SCHEMA);
    assert.equal(r.event, "control.evaluated");
    assert.equal(r.repository, "o/r");
    assert.match(r.control.id, /^[A-Z]+(-[A-Z]+)?-\d+$/);
    assert.ok(r.control.catalog !== "" && r.control.version !== "" && r.control.check !== "");
    assert.ok(r.result === "pass" || r.result === "fail");
    assert.ok(r.evidence.length > 0);
  }
  assert.equal(toJsonl([]), "");
});

test("PRs merged before the base date are not audited", () => {
  const old = goodPr(1, { reviews: [] });
  old.info.mergedAt = "2026-10-01T00:00:00Z";
  const a = audit(fakeGh({ prs: [old, goodPr(2)], mainCommits: [] }).gh, opts);
  assert.equal(a.result, "pass");
  assert.equal(a.records.filter((r) => r.subject.pr === 1).length, 0);
});

test("no approval by the reviewer identity fails independent-approval-at-head and opens one finding", () => {
  const p = goodPr(3, { reviews: [] });
  const f = fakeGh({ prs: [p] });
  const a = audit(f.gh, opts);
  assert.equal(a.result, "fail");
  assert.ok(checksFailed(a, 3).includes("independent-approval-at-head"));
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]?.title, prFindingTitle(3));
  assert.match(f.created[0]?.body ?? "", /no verdict by ruzni-reviewer/);
  assert.equal(a.findings[0]?.action, "opened");
});

test("an approval by someone else, or at an older head, does not count", () => {
  const p1 = goodPr(4);
  p1.reviews = [{ user: { login: "someone-else" }, state: "APPROVED", commit_id: p1.info.head, body: "## Second opinion — codex" }];
  const p2 = goodPr(5);
  p2.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: "f".repeat(40), body: "## Second opinion — codex" }];
  const a = audit(fakeGh({ prs: [p1, p2] }).gh, opts);
  assert.ok(checksFailed(a, 4).includes("independent-approval-at-head"));
  assert.ok(checksFailed(a, 5).includes("independent-approval-at-head"));
});

test("a later CHANGES_REQUESTED or DISMISSED at the head supersedes an earlier approval", () => {
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
    const p = goodPr(6);
    p.reviews.push({ user: { login: "ruzni-reviewer" }, state, commit_id: p.info.head, body: "x" });
    const a = audit(fakeGh({ prs: [p] }).gh, opts);
    assert.ok(checksFailed(a, 6).includes("independent-approval-at-head"), state);
  }
});

test("a required check that is red, missing or still running fails required-checks-green", () => {
  const red = goodPr(7);
  red.runs = cfg.requiredContexts.map((c) => (c === "gate" ? { ...green(c), conclusion: "failure" } : green(c)));
  const missing = goodPr(8);
  missing.runs = cfg.requiredContexts.filter((c) => c !== "DCO").map((c) => green(c));
  const running = goodPr(9);
  running.runs = cfg.requiredContexts.map((c) => (c === "security-fast" ? { ...green(c), status: "in_progress", conclusion: null } : green(c)));
  const a = audit(fakeGh({ prs: [red, missing, running] }).gh, opts);
  for (const n of [7, 8, 9]) assert.ok(checksFailed(a, n).includes("required-checks-green"), `PR ${n}`);
  assert.match(failed(a).find((r) => r.subject.pr === 7 && r.control.check === "required-checks-green")?.reasons.join() ?? "", /gate.*failure/);
  assert.match(failed(a).find((r) => r.subject.pr === 8 && r.control.check === "required-checks-green")?.reasons.join() ?? "", /DCO.*has not run/);
});

test("a commit without Signed-off-by fails dco-signoff and names the commit", () => {
  const p = goodPr(10);
  p.commits = [...p.commits, { sha: "b".repeat(40), message: "fix: later\n\nAgent-Vendor: claude" }];
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  const r = failed(a).find((x) => x.control.check === "dco-signoff");
  assert.ok(r !== undefined);
  assert.match(r.reasons.join(), new RegExp("b".repeat(40)));
  assert.ok(!checksFailed(a, 10).includes("agent-vendor-trailer"));
});

test("zero, two or mixed Agent-Vendor trailers fail agent-vendor-trailer", () => {
  const none = goodPr(11);
  none.commits = [{ sha: none.info.head, message: "feat: x\n\nSigned-off-by: A Dev <dev@example.com>" }];
  const two = goodPr(12);
  two.commits = [{ sha: two.info.head, message: `${msg("feat: x")}\nAgent-Vendor: codex` }];
  const mixed = goodPr(13);
  mixed.commits = [{ sha: "c".repeat(40), message: msg("a", "claude") }, { sha: mixed.info.head, message: msg("b", "codex") }];
  const a = audit(fakeGh({ prs: [none, two, mixed] }).gh, opts);
  for (const n of [11, 12, 13]) assert.ok(checksFailed(a, n).includes("agent-vendor-trailer"), `PR ${n}`);
  assert.match(failed(a).find((r) => r.subject.pr === 13 && r.control.check === "agent-vendor-trailer")?.reasons.join() ?? "", /mixed vendors/);
});

test("reviewer vendor equal to author vendor fails vendor-separation and says which vendor was expected", () => {
  const p = goodPr(14);
  p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "## Second opinion — claude\n\nVERDICT: APPROVE" }];
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  assert.deepEqual(checksFailed(a, 14), ["vendor-separation"]);
  assert.match(failed(a)[0]?.reasons.join() ?? "", /equals author vendor claude \(expected codex\)/);
});

test("an approving review that declares no reviewer vendor fails vendor-separation (fail closed)", () => {
  const p = goodPr(15);
  p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "LGTM" }];
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  assert.deepEqual(checksFailed(a, 15), ["vendor-separation"]);
});

test("a codex author is separated by a claude reviewer", () => {
  const p = goodPr(16);
  p.commits = [{ sha: p.info.head, message: msg("feat", "codex") }];
  p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "## Second opinion — claude" }];
  assert.equal(audit(fakeGh({ prs: [p] }).gh, opts).result, "pass");
});

test("an unreadable source fails its control with the reason instead of passing", () => {
  const a = audit(fakeGh({ prs: [goodPr(17)], failOn: new Set(["reviews", "checkRuns", "commits"]) }).gh, opts);
  assert.deepEqual(checksFailed(a, 17).sort(), ["agent-vendor-trailer", "dco-signoff", "independent-approval-at-head", "required-checks-green", "vendor-separation"]);
  assert.match(failed(a).find((r) => r.control.check === "required-checks-green")?.reasons.join() ?? "", /could not read check runs.*502/);
});

test("a failure to list merged PRs fails the run and still writes protection and direct-push evidence", () => {
  const a = audit(fakeGh({ prs: [goodPr(18)], failOn: new Set(["mergedPrs"]) }).gh, opts);
  assert.equal(a.result, "fail");
  assert.match(a.errors.join(), /could not list merged pull requests.*502/);
  assert.ok(a.records.some((r) => r.control.check === "branch-protection"));
});

test("a direct push to main (commit with no merged PR) is a finding", () => {
  const direct: Commit = { sha: "d".repeat(40), message: "oops" };
  const f = fakeGh({ prs: [goodPr(19)], direct: [direct] });
  const a = audit(f.gh, opts);
  assert.equal(a.result, "fail");
  const r = failed(a);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.control.check, "no-direct-push");
  assert.equal(r[0]?.subject.sha, direct.sha);
  assert.equal(f.created[0]?.title, directPushFindingTitle(direct.sha));
});

test("protectionDrift: equal policy has no drift; each deviation is reported", () => {
  assert.deepEqual(protectionDrift(GOOD_PROTECTION, cfg), []);
  const cases: [string, Protection, RegExp][] = [
    ["missing context", { ...GOOD_PROTECTION, required_status_checks: { strict: true, contexts: ["gate"] } }, /required contexts/],
    ["extra context", { ...GOOD_PROTECTION, required_status_checks: { strict: true, contexts: [...cfg.requiredContexts, "extra"] } }, /required contexts/],
    ["not strict", { ...GOOD_PROTECTION, required_status_checks: { strict: false, contexts: [...cfg.requiredContexts] } }, /strict/],
    ["no status checks", { ...GOOD_PROTECTION, required_status_checks: null }, /status checks are not enabled/],
    ["admins exempt", { ...GOOD_PROTECTION, enforce_admins: { enabled: false } }, /admins/],
    ["no PR reviews", { ...GOOD_PROTECTION, required_pull_request_reviews: null }, /reviews are not required/],
    ["zero approvals", { ...GOOD_PROTECTION, required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true } }, /approving reviews is 0/],
    ["two approvals", { ...GOOD_PROTECTION, required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true } }, /approving reviews is 2/],
    ["stale kept", { ...GOOD_PROTECTION, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false } }, /stale/],
    ["force push", { ...GOOD_PROTECTION, allow_force_pushes: { enabled: true } }, /force-push/],
    ["deletions", { ...GOOD_PROTECTION, allow_deletions: { enabled: true } }, /deletion/],
  ];
  for (const [name, live, re] of cases) assert.match(protectionDrift(live, cfg).join("; "), re, name);
  const viaChecks: Protection = { ...GOOD_PROTECTION, required_status_checks: { strict: true, checks: cfg.requiredContexts.map((context) => ({ context })) } };
  assert.deepEqual(protectionDrift(viaChecks, cfg), []);
});

test("protection drift is a finding; an unreadable protection (e.g. 403/404) fails closed", () => {
  const drift = fakeGh({ protection: { ...GOOD_PROTECTION, enforce_admins: { enabled: false } } });
  const a = audit(drift.gh, opts);
  assert.equal(a.result, "fail");
  assert.equal(drift.created[0]?.title, protectionFindingTitle("main"));
  const unreadable = fakeGh({ protection: new Error("HTTP 403: Resource not accessible by integration") });
  const b = audit(unreadable.gh, opts);
  assert.equal(b.result, "fail");
  assert.match(failed(b)[0]?.reasons.join() ?? "", /could not read branch protection.*403/);
});

test("findings are deduped: an open finding for the same violation set is refreshed, not duplicated", () => {
  const f = fakeGh({ prs: [goodPr(20, { reviews: [] })], open: [{ number: 77, title: prFindingTitle(20) }] });
  const a = audit(f.gh, opts);
  assert.deepEqual(f.created, []);
  assert.equal(f.updated.length, 1);
  assert.equal(f.updated[0]?.issue, 77);
  assert.deepEqual(a.findings.map((x) => x.action), ["updated"]);
  // a second run on the same world adds nothing new
  const g = fakeGh({ prs: [goodPr(20, { reviews: [] })] });
  audit(g.gh, opts);
  audit(g.gh, opts);
  assert.equal(g.created.length, 1);
  assert.equal(g.updated.length, 1);
});

test("one finding per violation set: two failing PRs and a drift open three issues", () => {
  const f = fakeGh({ prs: [goodPr(21, { reviews: [] }), goodPr(22, { commits: [{ sha: "e".repeat(40), message: "no trailers" }] })],
    protection: { ...GOOD_PROTECTION, allow_force_pushes: { enabled: true } } });
  audit(f.gh, opts);
  assert.deepEqual(f.created.map((c) => c.title), [prFindingTitle(21), prFindingTitle(22), protectionFindingTitle("main")]);
  assert.ok(f.labels() >= 1);
});

test("a GitHub failure while writing a finding is recorded, not thrown, and the evidence survives", () => {
  const f = fakeGh({ prs: [goodPr(23, { reviews: [] })], failOn: new Set(["createIssue"]) });
  const a = audit(f.gh, opts);
  assert.equal(a.result, "fail");
  assert.equal(a.findings[0]?.action, "error");
  assert.ok(a.records.length > 0);
  const g = fakeGh({ prs: [goodPr(24, { reviews: [] })], failOn: new Set(["openFindings"]) });
  assert.equal(audit(g.gh, opts).findings[0]?.action, "error");
});

test("parseConfig reads .gibson-delivery.json and rejects an incomplete one", () => {
  const c = parseConfig(JSON.stringify({ defaultBranch: "main", requiredContexts: ["gate", "DCO"], reviewerLogin: "ruzni-reviewer", model: "tag-pin" }));
  assert.deepEqual(c, { defaultBranch: "main", requiredContexts: ["gate", "DCO"], reviewerLogin: "ruzni-reviewer" });
  assert.throws(() => parseConfig("{"), /not valid JSON/);
  assert.throws(() => parseConfig(JSON.stringify({ defaultBranch: "main", requiredContexts: [], reviewerLogin: "x" })), /requiredContexts/);
  assert.throws(() => parseConfig(JSON.stringify({ defaultBranch: "main", requiredContexts: ["gate"] })), /reviewerLogin/);
});
