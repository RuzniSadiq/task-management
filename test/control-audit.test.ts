import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, WAIVERS_SCHEMA, audit, directPushFindingTitle, parseConfig, parseWaivers, prFindingTitle, protectionDrift, protectionFindingTitle, toJsonl } from "../scripts/control-audit.ts";
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
    reviews: (n) => { bad("reviews"); return byPr(n).reviews.map((r) => ("submitted_at" in r ? r : { ...r, submitted_at: "2026-11-02T12:00:00Z" })); },
    checkRuns: (sha) => { bad("checkRuns"); const f = prs.find((p) => p.info.head === sha); if (f === undefined) throw new Error("no head"); return f.runs; },
    protection: () => { bad("protection"); const p = w.protection ?? GOOD_PROTECTION; if (p instanceof Error) throw p; return p; },
    branchPushes: () => { bad("branchPushes"); return mainCommits.length === 0 ? [] : [{ before: "b".repeat(40), after: "a".repeat(40), timestamp: "2026-11-03T01:00:00Z" }]; },
    compare: () => { bad("compare"); return mainCommits; },
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
  assert.match(failed(a)[0]?.reasons.join() ?? "", /reviewer vendor claude is not the vendor selected for author claude \(expected codex\)/);
});

test("a reviewer vendor that differs from the author but is not the selected one fails vendor-separation", () => {
  const p = goodPr(40);
  p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "## Second opinion — grok\n\nVERDICT: APPROVE" }];
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  assert.deepEqual(checksFailed(a, 40), ["vendor-separation"]);
  assert.match(failed(a)[0]?.reasons.join() ?? "", /reviewer vendor grok is not the vendor selected for author claude \(expected codex\)/);
});

test("a codex author must be reviewed by claude; claude passes, codex and grok fail", () => {
  const verdicts = new Map<string, string[]>();
  for (const [n, rv] of [[41, "claude"], [42, "codex"], [43, "grok"]] as const) {
    const p = goodPr(n);
    p.commits = [{ sha: p.info.head, message: msg("feat: x", "codex") }];
    p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: `## Second opinion — ${rv}\n\nVERDICT: APPROVE` }];
    verdicts.set(rv, checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), n));
  }
  assert.deepEqual(verdicts.get("claude"), []);
  assert.deepEqual(verdicts.get("codex"), ["vendor-separation"]);
  assert.deepEqual(verdicts.get("grok"), ["vendor-separation"]);
});

test("an approving review declaring conflicting reviewer vendors fails vendor-separation (fail closed)", () => {
  const p = goodPr(44);
  p.reviews = [{ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "## Second opinion — codex\n\nx\n\n## Second opinion — claude\n\nVERDICT: APPROVE" }];
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  assert.deepEqual(checksFailed(a, 44), ["vendor-separation"]);
  assert.match(failed(a)[0]?.reasons.join() ?? "", /conflicting reviewer vendors/);
});

test("Signed-off-by and Agent-Vendor lines in the message body, not the trailer block, do not count", () => {
  const body = "feat: x\n\nSigned-off-by: A Dev <dev@example.com>\nAgent-Vendor: claude\n\nSome closing prose.";
  const inProse = "feat: x\n\nNotes for the reader\nSigned-off-by: A Dev <dev@example.com>\nAgent-Vendor: claude";
  const subjectOnly = "Signed-off-by: A Dev <dev@example.com>\nAgent-Vendor: claude";
  const onlyDco = "feat: x\n\nAgent-Vendor: claude\n\nSome closing prose with Signed-off-by: A Dev <dev@example.com>";
  const onlyVendor = "feat: x\n\nSigned-off-by: A Dev <dev@example.com>\n\nAgent-Vendor: claude in prose now.";
  const results = new Map<string, string[]>();
  [body, inProse, subjectOnly, onlyDco, onlyVendor].forEach((m, i) => {
    const p = goodPr(50 + i);
    p.commits = [{ sha: p.info.head, message: m }];
    results.set(String(i), checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 50 + i).sort());
  });
  const both = ["agent-vendor-trailer", "dco-signoff", "vendor-separation"];
  assert.deepEqual(results.get("0"), both);
  assert.deepEqual(results.get("1"), both);
  assert.deepEqual(results.get("2"), both);
  assert.ok(results.get("3")?.includes("dco-signoff"));
  assert.ok(results.get("4")?.includes("agent-vendor-trailer"));
});

test("the Gibson reservation commit (Agent-Vendor in its own paragraph before the other trailers) passes", () => {
  const p = goodPr(56);
  p.commits = [{ sha: p.info.head, message: "chore: reserve issue #41\n\nAgent-Vendor: claude\n\nGibson-Reservation: v1\nGibson-Issue: #41\nSigned-off-by: A Dev <dev@example.com>\n" }];
  assert.deepEqual(checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 56), []);
});

test("a real trailer block passes, including CRLF messages and continuation lines", () => {
  const p = goodPr(55);
  p.commits = [{ sha: p.info.head, message: "feat: x\r\n\r\nbody text\r\n\r\nCo-Authored-By: B <b@example.com>\r\nAgent-Vendor: claude\r\nSigned-off-by: A Dev <dev@example.com>\r\n" }];
  assert.deepEqual(checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 55), []);
});

test("an approval at the exact head submitted after the merge, or with no valid time, does not count", () => {
  const rv = (submitted_at: string | null, p: Fixture) => ({ user: { login: "ruzni-reviewer" }, state: "APPROVED", commit_id: p.info.head, body: "## Second opinion — codex\n\nVERDICT: APPROVE", submitted_at });
  const late = goodPr(60); late.reviews = [rv("2026-11-03T00:00:01Z", late)];
  const none = goodPr(61); none.reviews = [rv(null, none)];
  const bad = goodPr(62); bad.reviews = [rv("not a date", bad)];
  const edge = goodPr(63); edge.reviews = [rv("2026-11-03T00:00:00Z", edge)];
  const a = audit(fakeGh({ prs: [late, none, bad, edge] }).gh, opts);
  for (const n of [60, 61, 62]) assert.ok(checksFailed(a, n).includes("independent-approval-at-head"), `PR ${n}`);
  assert.match(failed(a).find((r) => r.subject.pr === 60 && r.control.check === "independent-approval-at-head")?.reasons.join() ?? "", /before the merge/);
  assert.deepEqual(checksFailed(a, 63), [], "approval at the merge instant counts");
});

test("a post-merge CHANGES_REQUESTED does not undo an approval given before the merge", () => {
  const p = goodPr(64);
  p.reviews.push({ user: { login: "ruzni-reviewer" }, state: "CHANGES_REQUESTED", commit_id: p.info.head, body: "x", submitted_at: "2026-11-04T00:00:00Z" });
  assert.deepEqual(checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 64), []);
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

// ---------------------------------------------------------------------------------------------
// Test-engineer sensors (PR #48): edge cases per rule, the workflow contract (AC1) and the CLI end
// to end through the real ghCli with a fake `gh` on PATH (AC4/AC5: pagination, evidence, issue I/O).
// ---------------------------------------------------------------------------------------------

test("reviewer verdicts: only the latest verdict at the head counts; other heads and deleted users are ignored", () => {
  const head = (n: number): string => goodPr(n).info.head;
  // APPROVED at head, then CHANGES_REQUESTED at an OLDER head afterwards: still approved at head
  const p1 = goodPr(30);
  p1.reviews.push({ user: { login: "ruzni-reviewer" }, state: "CHANGES_REQUESTED", commit_id: "f".repeat(40), body: "x" });
  // CHANGES_REQUESTED first, APPROVED later at head: approved
  const p2 = goodPr(31);
  p2.reviews = [{ user: { login: "ruzni-reviewer" }, state: "CHANGES_REQUESTED", commit_id: head(31), body: "x" }, ...p2.reviews];
  // COMMENTED after APPROVED does not supersede
  const p3 = goodPr(32);
  p3.reviews.push({ user: { login: "ruzni-reviewer" }, state: "COMMENTED", commit_id: head(32), body: "nit" });
  // PENDING review and a deleted user (null) are not verdicts
  const p4 = goodPr(33);
  p4.reviews = [{ user: null, state: "APPROVED", commit_id: head(33), body: "## Second opinion — codex" }, { user: { login: "ruzni-reviewer" }, state: "PENDING", commit_id: head(33), body: "" }];
  // login match is exact
  const p5 = goodPr(34);
  p5.reviews = [{ user: { login: "Ruzni-Reviewer" }, state: "APPROVED", commit_id: head(34), body: "## Second opinion — codex" }];
  const a = audit(fakeGh({ prs: [p1, p2, p3, p4, p5] }).gh, opts);
  for (const n of [30, 31, 32]) assert.deepEqual(checksFailed(a, n), [], `PR ${n}`);
  for (const n of [33, 34]) assert.ok(checksFailed(a, n).includes("independent-approval-at-head"), `PR ${n}`);
});

test("a failing approval names the actual verdict state, and separation fails closed with it", () => {
  const p = goodPr(35);
  p.reviews.push({ user: { login: "ruzni-reviewer" }, state: "CHANGES_REQUESTED", commit_id: p.info.head, body: "no" });
  const a = audit(fakeGh({ prs: [p] }).gh, opts);
  assert.match(failed(a).find((r) => r.control.check === "independent-approval-at-head")?.reasons.join() ?? "", /is CHANGES_REQUESTED, not APPROVED/);
  assert.ok(checksFailed(a, 35).includes("vendor-separation"));
});

test("DCO: a malformed or empty sign-off, or a PR with no commits, fails dco-signoff", () => {
  const cases: [string, Commit[]][] = [
    ["no email", [{ sha: "1".repeat(40), message: msg("x").replace("<dev@example.com>", "") }]],
    ["empty name", [{ sha: "2".repeat(40), message: "x\n\nAgent-Vendor: claude\n\nSigned-off-by: <dev@example.com>" }]],
    ["trailer text mid-word", [{ sha: "3".repeat(40), message: "x\n\nAgent-Vendor: claude\n\nnot-Signed-off-by: A <a@b.c>" }]],
    ["no commits", []],
  ];
  cases.forEach(([name, commits], i) => {
    const p = goodPr(40 + i);
    p.commits = commits;
    assert.ok(checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 40 + i).includes("dco-signoff"), name);
  });
});

test("a PR with no merge time is not audited as merged", () => {
  const p = goodPr(45);
  p.info.mergedAt = "";
  const a = audit(fakeGh({ prs: [p], mainCommits: [] }).gh, opts);
  assert.equal(a.records.filter((r) => r.subject.pr === 45).length, 0);
});

test("--since is inclusive at the boundary instant", () => {
  const p = goodPr(46);
  p.info.mergedAt = opts.since;
  assert.equal(audit(fakeGh({ prs: [p] }).gh, opts).records.filter((r) => r.subject.pr === 46).length, 6);
});

test("direct push: an unreadable PR lookup fails closed; a failed commit listing fails the run", () => {
  const direct: Commit = { sha: "d".repeat(40), message: "oops" };
  const a = audit(fakeGh({ prs: [], direct: [direct], failOn: new Set(["mergedPrsOf"]) }).gh, opts);
  assert.equal(a.result, "fail");
  assert.match(failed(a)[0]?.reasons.join() ?? "", /could not read pull requests of d+: HTTP 502/);
  const b = audit(fakeGh({ prs: [goodPr(47)], failOn: new Set(["branchPushes"]) }).gh, opts);
  assert.equal(b.result, "fail");
  assert.match(b.errors.join(), /could not list pushes to main.*502/);
  assert.ok(b.records.some((r) => r.control.check === "branch-protection"));
});

test("a squash-merge commit that belongs to a merged PR is not a direct push; one that belongs to none is", () => {
  const p = goodPr(48);
  const squash: Commit = { sha: "9".repeat(40), message: "squash of 48" };
  const f = fakeGh({ prs: [p], mainCommits: [squash] });
  f.gh.mergedPrsOf = (sha) => (sha === squash.sha ? [48] : []);
  assert.equal(audit(f.gh, opts).result, "pass");
  f.gh.mergedPrsOf = () => [];
  assert.deepEqual(failed(audit(f.gh, opts)).map((r) => r.control.check), ["no-direct-push"]);
});

test("protectionDrift: unset fields fail closed, checks[] wins over contexts[], every deviation is reported at once", () => {
  assert.equal(protectionDrift({}, cfg).length, 6);
  const both: Protection = { ...GOOD_PROTECTION, required_status_checks: { strict: true, contexts: ["stale"], checks: cfg.requiredContexts.map((context) => ({ context })) } };
  assert.deepEqual(protectionDrift(both, cfg), []);
  const unset: Protection = { ...GOOD_PROTECTION, required_pull_request_reviews: {} };
  assert.match(protectionDrift(unset, cfg).join("; "), /approving reviews is unset/);
  assert.match(protectionDrift({ ...GOOD_PROTECTION, allow_force_pushes: undefined, allow_deletions: null }, cfg).join("; "), /force-push.*deletion/);
});

test("the finding body carries the run URL, control id, check name, reasons and PR link", () => {
  const f = fakeGh({ prs: [goodPr(49, { reviews: [] })] });
  audit(f.gh, opts);
  const body = f.created[0]?.body ?? "";
  for (const s of [run.url, "SDLC-SEC-008", "independent-approval-at-head", "no verdict by ruzni-reviewer", "https://github.com/o/r/pull/49"]) assert.ok(body.includes(s), s);
});

test("several failing controls on one PR share one finding, refreshed with all of them", () => {
  const f = fakeGh({ prs: [goodPr(50, { reviews: [], runs: [] })], open: [{ number: 9, title: prFindingTitle(50) }] });
  const a = audit(f.gh, opts);
  assert.equal(f.created.length, 0);
  assert.match(f.updated[0]?.body ?? "", /independent-approval-at-head[\s\S]*required-checks-green/);
  assert.equal(a.findings.length, 1);
});

test("evidence: one record per PR per control; ids are the cited catalogue ids; every record carries run and time", () => {
  const a = audit(fakeGh({ prs: [goodPr(51), goodPr(52)] }).gh, opts);
  const perPr = new Map<number, string[]>();
  for (const r of a.records) if (r.subject.pr !== undefined) perPr.set(r.subject.pr, [...(perPr.get(r.subject.pr) ?? []), r.control.check]);
  for (const checks of perPr.values()) assert.equal(new Set(checks).size, checks.length, "no control twice for a PR");
  assert.deepEqual([...perPr.keys()], [51, 52]);
  assert.deepEqual([...new Set(a.records.map((r) => r.control.id))].sort(), ["MI-21", "MI-4", "RC-005", "SDLC-SEC-008"]);
  assert.ok(a.records.every((r) => r.recorded_at === "2026-11-05T00:00:00.000Z" && r.run === run));
});

// ---- AC1: the workflow file itself ------------------------------------------------------------

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/control-audit.yml", import.meta.url)), "utf8");

test("AC1: workflow triggers on push to main, a daily schedule and workflow_dispatch", () => {
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}schedule:\n {4}- cron: "\d{1,2} \d{1,2} \* \* \*"\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test("AC1: every action is pinned by a full commit SHA", () => {
  const uses = workflow.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 3, "checkout, setup-node, upload-artifact");
  for (const l of uses) assert.match(l, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s|$)/, l);
});

test("AC1: the privileged job runs only from refs/heads/main, so a dispatch from another branch cannot run its script with the token", () => {
  assert.match(workflow, /^ {4}name: audit\n(?: {4}#.*\n)* {4}if: github\.ref == 'refs\/heads\/main'\n {4}runs-on: /m);
  assert.doesNotMatch(workflow, /^ {6}ref:/m, "checkout must not take a caller-chosen ref");
  assert.doesNotMatch(workflow, /inputs\./, "no dispatch input may reach the job");
});

test("AC1: permissions are empty at workflow level and exactly contents/pull-requests read + issues write on the job", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const block = /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(workflow)?.[1];
  assert.ok(block !== undefined, "job-level permissions block");
  assert.deepEqual(block.trim().split("\n").map((l) => l.trim()).sort(), ["contents: read", "issues: write", "pull-requests: read"]);
  assert.equal(workflow.match(/permissions:/g)?.length, 2, "no other permissions grants");
  assert.match(workflow, /persist-credentials: false/);
});

test("AC1/AC4: the audit token is the only secret used, and the evidence is always uploaded as an artifact", () => {
  assert.deepEqual(workflow.match(/secrets\.\w+/g), ["secrets.CONTROL_AUDIT_TOKEN"]);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.CONTROL_AUDIT_TOKEN \|\| github\.token \}\}/);
  assert.match(workflow, /run: node scripts\/control-audit\.ts --repo "\$GITHUB_REPOSITORY" --since 2026-11-04T15:00:00Z --out control-evidence\.jsonl/);
  assert.match(workflow, /- uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n {8}if: always\(\)\n {8}with:\n(?: {10}.*\n)*? {10}path: control-evidence\.jsonl\n/);
});

// ---- AC4/AC5: the CLI end to end, real ghCli against a fake `gh` -------------------------------

const SCRIPT = fileURLToPath(new URL("../scripts/control-audit.ts", import.meta.url));

/** A stand-in `gh` (CommonJS, Node builtins only): serves canned lists by API path and logs every call. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const a = process.argv.slice(2);
const log = (stdin) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: a, stdin }) + "\\n");
const fail = (msg) => { process.stderr.write(msg + "\\n"); return 1; };
function main() {
  if (a[0] === "api") {
    log(null);
    const path = a.find((x) => x.startsWith("repos/"));
    const key = path.split("?")[0];
    if (st.failPaths.includes(key)) return fail("HTTP 403: Resource not accessible by integration");
    if (a.includes("--slurp")) { process.stdout.write(JSON.stringify([st.open.slice(0, 1), st.open.slice(1)])); return 0; }
    const r = st.routes[key];
    if (r === undefined) return fail("HTTP 404 " + key);
    process.stdout.write(Array.isArray(r) ? r.map((x) => JSON.stringify(x) + "\\n").join("") : JSON.stringify(r));
    return 0;
  }
  if (a[0] === "label" && a[1] === "create") { log(null); return 0; }
  if (a[0] === "issue" && (a[1] === "create" || a[1] === "edit")) {
    log(fs.readFileSync(0, "utf8"));
    if (st.failIssueWrites) return fail("HTTP 502: Bad Gateway");
    if (a[1] === "create") process.stdout.write(st.createOutput);
    return 0;
  }
  log(null);
  return fail("fake gh: unexpected call");
}
process.exitCode = main();
`;

interface CliWorld { prs?: Fixture[]; protection?: Protection; direct?: Commit[]; open?: Issue[]; failPaths?: string[]; failIssueWrites?: boolean; createOutput?: string }
interface GhCall { args: string[]; stdin: string | null }

function runCli(w: CliWorld, extra: string[] = [], configText?: string) {
  const dir = mkdtempSync(join(tmpdir(), "control-audit-cli-"));
  try {
    const prs = w.prs ?? [];
    const routes: Record<string, unknown> = {
      "repos/o/r/pulls": prs.map((p) => p.info),
      "repos/o/r/branches/main/protection": w.protection ?? GOOD_PROTECTION,
      "repos/o/r/activity": [{ before: "b".repeat(40), after: "a".repeat(40), timestamp: "2026-11-03T01:00:00Z" }],
      [`repos/o/r/compare/${"b".repeat(40)}...${"a".repeat(40)}`]: [...prs.map((p) => ({ sha: p.info.head, message: "squash" })), ...(w.direct ?? [])],
    };
    for (const p of prs) {
      routes[`repos/o/r/pulls/${p.info.number}/commits`] = p.commits;
      routes[`repos/o/r/pulls/${p.info.number}/reviews`] = p.reviews.map((r) => ("submitted_at" in r ? r : { ...r, submitted_at: "2026-11-02T12:00:00Z" }));
      routes[`repos/o/r/commits/${p.info.head}/check-runs`] = p.runs;
      routes[`repos/o/r/commits/${p.info.head}/pulls`] = [p.info.number];
    }
    for (const c of w.direct ?? []) routes[`repos/o/r/commits/${c.sha}/pulls`] = [];
    writeFileSync(join(dir, "state.json"), JSON.stringify({ routes, open: w.open ?? [], failPaths: w.failPaths ?? [], failIssueWrites: w.failIssueWrites ?? false,
      createOutput: w.createOutput ?? "https://github.com/o/r/issues/321\n" }));
    writeFileSync(join(dir, "gh"), FAKE_GH, { mode: 0o755 });
    writeFileSync(join(dir, "calls.jsonl"), "");
    writeFileSync(join(dir, "delivery.json"), configText ?? JSON.stringify({ defaultBranch: "main", requiredContexts: cfg.requiredContexts, reviewerLogin: cfg.reviewerLogin }));
    const out = join(dir, "evidence.jsonl");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_STATE: join(dir, "state.json"),
      FAKE_GH_LOG: join(dir, "calls.jsonl"),
      GITHUB_RUN_ID: "4242",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
    };
    // extras come first: the script takes the first occurrence of a flag, so they override the defaults
    const args = [...extra, "--repo", "o/r", "--out", out, "--config", join(dir, "delivery.json"), "--since", "2026-11-01T00:00:00Z"];
    const p = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as GhCall);
    const records = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as ControlRecord) : undefined;
    return { status: p.status, stdout: p.stdout, stderr: p.stderr, calls, records };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUN_URL = "https://github.com/o/r/actions/runs/4242";
const writes = (calls: GhCall[]) => calls.filter((c) => c.args[0] === "label" || c.args[0] === "issue");

test("CLI clean pass: exit 0, JSONL written, every list call is paginated, no issue writes", () => {
  const r = runCli({ prs: [goodPr(1), goodPr(2)] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.records?.length, 6 * 2 + 1 + 2, "6 per PR, protection, one no-direct-push per commit");
  assert.ok(r.records.every((x) => x.schema === SCHEMA && x.run.url === RUN_URL && x.run.attempt === "2" && x.result === "pass"));
  const apis = r.calls.filter((c) => c.args[0] === "api");
  const lists = apis.filter((c) => !c.args.some((x) => x.endsWith("/protection")));
  assert.equal(lists.length, 1 + 2 * 3 + 2 + 2, "merged PRs, 3 per PR (commits, reviews, check-runs), pushes + compare, PR lookup per commit");
  for (const c of lists) {
    assert.equal(c.args[1], "--paginate", c.args.join(" "));
    assert.ok(c.args.some((x) => x.includes("per_page=100")), c.args.join(" "));
  }
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /control-audit: pass \(15 record/);
});

test("a backdated commit pushed directly to main is still reported: the window is the push record, not the commit date", () => {
  // The commit's own date is irrelevant: it is returned by compare() for a push GitHub recorded in the window.
  const sneaky: Commit = { sha: "e".repeat(40), message: "backdated 2001-01-01\n\nSigned-off-by: A <a@b.co>" };
  const a = audit(fakeGh({ prs: [], direct: [sneaky] }).gh, opts);
  assert.deepEqual(failed(a).map((r) => r.control.check), ["no-direct-push"]);
  // A push recorded before the window is not re-audited, whatever its commits claim.
  const g = fakeGh({ prs: [], direct: [sneaky] }).gh;
  const old: Gh = { ...g, branchPushes: () => [{ before: "b".repeat(40), after: "a".repeat(40), timestamp: "2026-10-01T00:00:00Z" }] };
  assert.equal(audit(old, opts).result, "pass");
  const bad: Gh = { ...g, branchPushes: () => [{ before: "b".repeat(40), after: "a".repeat(40), timestamp: "not a date" }] };
  assert.equal(audit(bad, opts).result, "fail");
});

test("a push with no common ancestor (force push / history rewrite) becomes a finding; other compare failures stay errors", () => {
  const g = fakeGh({ prs: [] });
  const push = { before: "d".repeat(40), after: "9".repeat(40), timestamp: "2026-11-03T01:00:00Z" };
  const rewrite: Gh = { ...g.gh, branchPushes: () => [push], compare: () => { throw new Error("gh: No common ancestor between x and y. (HTTP 404)"); } };
  const a = audit(rewrite, opts);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(failed(a).map((r) => r.control.check), ["no-direct-push"]);
  assert.match(failed(a)[0]?.reasons.join() ?? "", /no common ancestor.*force push or history rewrite/);
  assert.deepEqual(a.findings.map((f) => f.action), ["opened"]);
  assert.equal(g.created[0]?.title, directPushFindingTitle(push.after));
  const other: Gh = { ...g.gh, branchPushes: () => [push], compare: () => { throw new Error("HTTP 502"); } };
  const b = audit(other, opts);
  assert.equal(b.result, "fail");
  assert.match(b.errors.join(), /could not list the commits of push.*502/);
});

test("CLI queries: merged PRs from the base branch, commits since the base date, protection by branch name", () => {
  const r = runCli({ prs: [goodPr(1)] });
  const paths = r.calls.map((c) => c.args.find((x) => x.startsWith("repos/")) ?? "");
  assert.ok(paths.includes("repos/o/r/pulls?state=closed&base=main&per_page=100"));
  assert.ok(paths.includes("repos/o/r/activity?ref=refs%2Fheads%2Fmain&per_page=100"), "pushes come from the activity record");
  assert.ok(!paths.some((x) => /since=/.test(x)), "no commit-date (since) filter: backdated commits would escape it");
  assert.ok(paths.includes("repos/o/r/branches/main/protection"));
  const merged = r.calls.find((c) => c.args.some((x) => x.startsWith("repos/o/r/pulls?")));
  assert.ok(merged?.args.some((x) => x.includes("merged_at != null")), "unmerged closed PRs are filtered out");
  const pulls = r.calls.find((c) => c.args.some((x) => /commits\/\w+\/pulls/.test(x)));
  assert.ok(pulls?.args.some((x) => x.includes('.base.ref == "main"') && x.includes("merged_at != null")));
});

test("CLI violations: exit 1, evidence names the failures, findings opened with label and the body on stdin", () => {
  const direct: Commit = { sha: "d".repeat(40), message: "oops" };
  const r = runCli({ prs: [goodPr(3, { reviews: [] })], direct: [direct], protection: { ...GOOD_PROTECTION, enforce_admins: { enabled: false } } });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.records?.filter((x) => x.result === "fail").map((x) => x.control.check).sort(), ["branch-protection", "independent-approval-at-head", "no-direct-push", "vendor-separation"]);
  const creates = r.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
  assert.deepEqual(creates.map((c) => c.args[c.args.indexOf("--title") + 1]), [prFindingTitle(3), protectionFindingTitle("main"), directPushFindingTitle(direct.sha)]);
  for (const c of creates) {
    assert.equal(c.args[c.args.indexOf("--label") + 1], "control-finding");
    assert.ok(c.args.includes("--body-file") && c.args.includes("-"), "body is passed on stdin, not argv");
    assert.ok(c.stdin?.includes(RUN_URL));
  }
  assert.ok(r.calls.some((c) => c.args[0] === "label" && c.args.includes("control-finding") && c.args.includes("--force")));
  assert.match(r.stdout, /FAIL pr #3 independent-approval-at-head/);
  assert.match(r.stdout, /finding opened: #321/);
});

test("CLI dedupe: an open finding on the second page is found and edited, never duplicated", () => {
  const open = [{ number: 5, title: "control-finding: something else" }, { number: 77, title: prFindingTitle(3) }];
  const r = runCli({ prs: [goodPr(3, { reviews: [] })], open });
  assert.equal(r.status, 1);
  assert.equal(r.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").length, 0);
  const edit = r.calls.find((c) => c.args[0] === "issue" && c.args[1] === "edit");
  assert.equal(edit?.args[2], "77");
  assert.ok(edit?.stdin?.includes("independent-approval-at-head"));
  const slurp = r.calls.find((c) => c.args.includes("--slurp"));
  assert.deepEqual(slurp?.args.slice(0, 3), ["api", "--paginate", "--slurp"]);
  assert.ok(slurp?.args.some((x) => x.includes("labels=control-finding") && x.includes("state=open")));
});

test("CLI --dry-run on a failing world: exit 1, evidence written, no label, issue create or edit", () => {
  const r = runCli({ prs: [goodPr(3, { reviews: [] })], open: [{ number: 77, title: prFindingTitle(3) }] }, ["--dry-run"]);
  assert.equal(r.status, 1);
  assert.ok(r.records?.some((x) => x.result === "fail"));
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /\[dry-run\] would open or update: /);
});

test("CLI unreadable protection (403) fails closed with the reason in evidence and a drift finding", () => {
  const r = runCli({ prs: [goodPr(1)], failPaths: ["repos/o/r/branches/main/protection"] });
  assert.equal(r.status, 1);
  const rec = r.records?.find((x) => x.control.check === "branch-protection");
  assert.equal(rec?.result, "fail");
  assert.match(rec.reasons.join(), /could not read branch protection of main: .*403/);
  assert.ok(r.calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"));
});

test("CLI cannot list merged PRs: exit 1, the evidence file is still written, ERROR on stdout, no findings invented", () => {
  const r = runCli({ prs: [goodPr(1)], failPaths: ["repos/o/r/pulls"] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR could not list merged pull requests: .*403/);
  assert.ok(r.records?.some((x) => x.control.check === "branch-protection"));
  assert.equal(r.records?.filter((x) => x.subject.kind === "pr").length, 0);
  assert.deepEqual(writes(r.calls), []);
});

test("CLI cannot write the finding: exit 1 and the evidence survives; a garbage create URL is an error finding", () => {
  const down = runCli({ prs: [goodPr(3, { reviews: [] })], failIssueWrites: true });
  assert.equal(down.status, 1);
  assert.match(down.stdout, /finding error \(pr-3\): could not open the finding: .*502/);
  assert.ok(down.records?.some((x) => x.result === "fail"));
  const junk = runCli({ prs: [goodPr(3, { reviews: [] })], createOutput: "created!\n" });
  assert.equal(junk.status, 1);
  assert.match(junk.stdout, /finding error \(pr-3\): .*returned no issue URL/);
});

test("CLI bad arguments exit 2 without calling GitHub: unparseable --since, missing or incomplete config", () => {
  const since = runCli({}, ["--since", "last tuesday"]);
  assert.equal(since.status, 2);
  assert.match(since.stdout, /ERROR --since is not a date: last tuesday/);
  assert.equal(since.calls.length, 0);
  const noConfig = runCli({}, ["--config", "/nonexistent/delivery.json"]);
  assert.equal(noConfig.status, 2);
  assert.match(noConfig.stdout, /^ERROR /);
  const bad = runCli({}, [], JSON.stringify({ defaultBranch: "main" }));
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /ERROR delivery config has no reviewerLogin/);
  assert.equal(bad.calls.length, 0);
});

// ---- #61: reviewed waivers ----------------------------------------------------------------------

const RATIONALE = "Merged before the review lane existed; reviewed and accepted by the owner.";
const waiverFor = (p: Fixture, check: string) => ({ pr: p.info.number, head: p.info.head, check, rationale: RATIONALE });

test("#61 a waived failure stays fail in the evidence with the waiver attached, opens no finding and the run passes", () => {
  const p = goodPr(70, { reviews: [] });
  const f = fakeGh({ prs: [p] });
  const w = waiverFor(p, "independent-approval-at-head");
  const failing = checksFailed(audit(fakeGh({ prs: [p] }).gh, opts), 70);
  const a = audit(f.gh, { ...opts, waivers: failing.map((c) => waiverFor(p, c)) });
  assert.ok(failing.includes(w.check));
  assert.equal(a.result, "pass");
  assert.equal(f.created.length, 0);
  assert.deepEqual(a.findings, []);
  const rec = a.records.find((r) => r.subject.pr === 70 && r.control.check === "independent-approval-at-head");
  assert.equal(rec?.result, "fail");
  assert.deepEqual(rec.waiver, w);
  assert.match(toJsonl(a.records), /"waiver":\{"pr":70/);
});

test("#61 a waiver for another head SHA does not apply", () => {
  const p = goodPr(71, { reviews: [] });
  const f = fakeGh({ prs: [p] });
  const a = audit(f.gh, { ...opts, waivers: [{ ...waiverFor(p, "independent-approval-at-head"), head: "f".repeat(40) }] });
  assert.equal(a.result, "fail");
  assert.equal(f.created.length, 1);
  assert.equal(a.records.find((r) => r.control.check === "independent-approval-at-head")?.waiver, undefined);
});

test("#61 a waiver for another check or another PR does not apply, and only the waived check is dropped from the finding", () => {
  const p = goodPr(72, { reviews: [], runs: [] });
  const f = fakeGh({ prs: [p] });
  const a = audit(f.gh, { ...opts, waivers: [waiverFor(p, "independent-approval-at-head"), { ...waiverFor(p, "required-checks-green"), pr: 99 }] });
  assert.equal(a.result, "fail");
  assert.equal(f.created.length, 1);
  assert.doesNotMatch(f.created[0]?.body ?? "", /independent-approval-at-head/);
  assert.match(f.created[0]?.body ?? "", /required-checks-green/);
});

test("#61 a PR that passes is unaffected by waivers", () => {
  const p = goodPr(73);
  const a = audit(fakeGh({ prs: [p] }).gh, { ...opts, waivers: [waiverFor(p, "dco-signoff")] });
  assert.equal(a.result, "pass");
  assert.ok(a.records.every((r) => r.waiver === undefined));
});

const waiversDoc = (waivers: unknown[]): string => JSON.stringify({ schema: WAIVERS_SCHEMA, waivers });
const okWaiver = { pr: 1, head: "a".repeat(40), check: "vendor-separation", rationale: RATIONALE };

test("#61 parseWaivers accepts a valid file and rejects every malformed shape (fail closed)", () => {
  assert.deepEqual(parseWaivers(waiversDoc([okWaiver])), [okWaiver]);
  assert.deepEqual(parseWaivers(waiversDoc([])), []);
  const bad: [string, string][] = [
    ["not json", "{"],
    ["wrong schema", JSON.stringify({ schema: "x", waivers: [] })],
    ["no waivers array", JSON.stringify({ schema: WAIVERS_SCHEMA })],
    ["null entry", waiversDoc([null])],
    ["short head", waiversDoc([{ ...okWaiver, head: "abc1234" }])],
    ["uppercase head", waiversDoc([{ ...okWaiver, head: "A".repeat(40) }])],
    ["wildcard head", waiversDoc([{ ...okWaiver, head: "*" }])],
    ["string pr", waiversDoc([{ ...okWaiver, pr: "1" }])],
    ["unknown check", waiversDoc([{ ...okWaiver, check: "branch-protection" }])],
    ["wildcard check", waiversDoc([{ ...okWaiver, check: "*" }])],
    ["short rationale", waiversDoc([{ ...okWaiver, rationale: "ok" }])],
    ["extra field", waiversDoc([{ ...okWaiver, until: "never" }])],
    ["duplicate", waiversDoc([okWaiver, okWaiver])],
  ];
  for (const [name, text] of bad) assert.throws(() => parseWaivers(text), Error, name);
});

test("#61 CLI: a malformed waivers file exits 2 before any audit; a missing file means no waivers", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-audit-waivers-"));
  try {
    const cfgPath = join(dir, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const bad = join(dir, "waivers.json");
    writeFileSync(bad, "{");
    const script = fileURLToPath(new URL("../scripts/control-audit.ts", import.meta.url));
    const r = spawnSync(process.execPath, [script, "--config", cfgPath, "--waivers", bad, "--out", join(dir, "o.jsonl"), "--dry-run"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /ERROR .*waivers file is not valid JSON/);
    assert.equal(existsSync(join(dir, "o.jsonl")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#61 a waiver never covers an evidence read failure: the check stays failed, a finding is filed and the run fails", () => {
  const p = goodPr(74);
  const f = fakeGh({ prs: [p], failOn: new Set(["checkRuns"]) });
  const a = audit(f.gh, { ...opts, waivers: [waiverFor(p, "required-checks-green")] });
  assert.equal(a.result, "fail");
  const rec = a.records.find((r) => r.subject.pr === 74 && r.control.check === "required-checks-green");
  assert.equal(rec?.result, "fail");
  assert.equal(rec.waiver, undefined);
  assert.match(rec.reasons.join(" "), /could not read check runs/);
  assert.equal(f.created.length, 1);
  assert.match(f.created[0]?.body ?? "", /could not read check runs/);
});

test("#61 a read failure on reviews is not waivable for any check that depends on it", () => {
  const p = goodPr(75);
  const f = fakeGh({ prs: [p], failOn: new Set(["reviews"]) });
  const failing = checksFailed(audit(fakeGh({ prs: [p], failOn: new Set(["reviews"]) }).gh, opts), 75);
  assert.ok(failing.length > 0);
  const a = audit(f.gh, { ...opts, waivers: failing.map((c) => waiverFor(p, c)) });
  assert.equal(a.result, "fail");
  assert.ok(a.records.every((r) => r.waiver === undefined));
});
