import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidence, answer, main, SCHEMA } from "../scripts/audit-query.ts";
import type { Answer } from "../scripts/audit-query.ts";
import { controlAuditJsonl } from "./audit-fixtures.ts";

const HEAD = "a".repeat(39) + "1";
const MERGE = "b".repeat(39) + "2";
const OTHER = "c".repeat(40);
const DIGEST = "d".repeat(64);

const audit = (o: Parameters<typeof controlAuditJsonl>[0][number] extends infer T ? Partial<T> : never = {}): string =>
  controlAuditJsonl([{ pr: 49, head: HEAD, ...o }]);

const releaseEvidence = {
  schema: SCHEMA, event: "release.published", recorded_at: "2026-11-05T10:00:00.000Z",
  artefact: { name: "task-management-0.1.0.tgz", sha256: DIGEST, tag: "v0.1.0", commit: MERGE },
  triggered_by: "RuzniSadiq",
  approvals: [{ login: "RuzniSadiq", state: "approved", comment: "ok" }],
  checks: { typecheck: "pass", lint: "pass", test: "pass", build: "pass" },
};
const verifyEvidence = (result: string, at: string) => ({
  schema: SCHEMA, event: "release.verified", recorded_at: at, repository: "o/r", result,
  releases: [{ tag: "v0.1.0", url: "u", result, artefacts: [], reasons: [] }], skipped: [], findings: [], controls: [],
});

function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-query-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const FULL = {
  "control-audit.jsonl": audit(),
  "v0.1.0/release-evidence.json": releaseEvidence,
  "verify-release-evidence.json": verifyEvidence("pass", "2026-11-05T12:00:00.000Z"),
};

function run(dir: string, args: string[]): { out: string; err: string; code: number } {
  let out = "";
  let err = "";
  const code = main([...args, "--evidence", dir], { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { out, err, code };
}

function ans(dir: string, q: string): Answer {
  const a = answer(loadEvidence(dir), q);
  assert.ok(!("ambiguous" in a));
  return a;
}

test("sha query answers all five questions from evidence alone", () => {
  const dir = fixture(FULL);
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.found, true);
    assert.deepEqual(a.change, { pr: 49, head_sha: HEAD, merge_sha: null, merged_at: "2026-11-03T00:00:00Z", author: "RuzniSadiq", author_vendor: "claude", merged_via_pr: "pass", vendor_declared: "pass" });
    assert.equal(a.approval?.independent_approval_at_head, "pass");
    assert.equal(a.approval?.vendor_separation, "pass");
    assert.equal(a.approval?.independent, true);
    assert.equal(a.approval?.reviewer, "ruzni-reviewer");
    assert.equal(a.approval?.reviewer_vendor, "codex");
    assert.deepEqual(a.checks?.conclusions, { gate: "success", "security-fast": "success", "test-integrity": "success", DCO: "success" });
    assert.equal(a.checks?.result, "pass");
    assert.deepEqual(a.checks?.passed, ["DCO", "gate", "security-fast", "test-integrity"]);
    assert.deepEqual(a.checks?.failure_reasons, []);
    assert.equal(a.checks?.controls.length, 6);
    const r = ans(dir, "v0.1.0");
    assert.equal(r.release?.sha256, DIGEST);
    assert.deepEqual(r.release?.approved_by, ["RuzniSadiq"]);
    assert.equal(r.verification?.reverified, true);
    assert.equal(r.verification?.result, "pass");
    assert.equal(r.verification?.since_release, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("short prefix resolves the change; the release commit and the tag resolve the release", () => {
  const dir = fixture(FULL);
  try {
    const byHead = ans(dir, HEAD.slice(0, 8));
    assert.equal(byHead.change?.head_sha, HEAD);
    assert.equal(byHead.release, null, "audit records carry no merge sha, so a head does not reach the release");
    for (const q of [MERGE, "v0.1.0"]) {
      const a = ans(dir, q);
      assert.equal(a.release?.tag, "v0.1.0", q);
      assert.equal(a.change, null, `${q}: no PR record at the merge commit`);
      assert.equal(a.verification?.result, "pass", q);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--json prints the answers and exits 0; text output names every question", () => {
  const dir = fixture(FULL);
  try {
    const j = run(dir, [HEAD, "--json"]);
    assert.equal(j.code, 0);
    const parsed = JSON.parse(j.out) as Answer;
    assert.equal(parsed.approval?.independent, true);
    assert.equal(parsed.release, null, "a head sha does not reach the release: audit records carry no merge sha");
    const tagged = JSON.parse(run(dir, ["v0.1.0", "--json"]).out) as Answer;
    assert.equal(tagged.release?.artefact, "task-management-0.1.0.tgz");
    const t = run(dir, [HEAD]);
    assert.equal(t.code, 0);
    for (const s of ["1. Who", "2. Who approved", "3. Which checks", "4. What was released", "5. Re-verified"]) assert.match(t.out, new RegExp(s));
    assert.match(t.out, /independent vendor \(vendor-separation\): yes/);
    assert.match(t.out, /author: RuzniSadiq; agent vendor: claude/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown sha and unknown tag exit non-zero with an explicit no-evidence message", () => {
  const dir = fixture(FULL);
  try {
    for (const q of [OTHER, "v9.9.9"]) {
      const t = run(dir, [q]);
      assert.equal(t.code, 1, q);
      assert.match(t.out, /NO EVIDENCE for /);
      const j = run(dir, [q, "--json"]);
      assert.equal(j.code, 1, q);
      const parsed = JSON.parse(j.out) as { found: boolean; error: string };
      assert.equal(parsed.found, false);
      assert.match(parsed.error, /^no evidence/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty evidence dir: no evidence, exit 1", () => {
  const dir = fixture({});
  try {
    assert.equal(run(dir, [HEAD]).code, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing pieces are reported as no evidence, not invented", () => {
  const dir = fixture({ "control-audit.jsonl": audit() });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.found, true);
    assert.equal(a.release, null);
    assert.equal(a.verification, null);
    const t = run(dir, [HEAD]);
    assert.match(t.out, /4\. What was released[^\n]*\n\s+no evidence/);
    assert.match(t.out, /5\. Re-verified[^\n]*\n\s+no evidence/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a release that was never re-verified says so", () => {
  const dir = fixture({ "release-evidence.json": releaseEvidence });
  try {
    const a = ans(dir, "v0.1.0");
    assert.equal(a.release?.artefact, "task-management-0.1.0.tgz");
    assert.equal(a.verification?.reverified, false);
    assert.match(run(dir, ["v0.1.0"]).out, /NO — no evidence of any re-verification/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the latest re-verification wins, and a failing one is reported as fail", () => {
  const dir = fixture({
    ...FULL,
    "verify-old.json": verifyEvidence("pass", "2026-11-05T11:00:00.000Z"),
    "verify-new.json": verifyEvidence("fail", "2026-11-06T00:00:00.000Z"),
  });
  try {
    const a = ans(dir, "v0.1.0");
    assert.equal(a.verification?.result, "fail");
    assert.equal(a.verification?.recorded_at, "2026-11-06T00:00:00.000Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same vendor is NOT independent; a non-approving verdict is reported with its reason", () => {
  const same = fixture({ "a.jsonl": audit({ authorVendor: "claude", reviewerVendor: "claude" }) });
  const changes = fixture({ "a.jsonl": audit({ verdict: "CHANGES_REQUESTED" }) });
  try {
    const a = ans(same, HEAD);
    assert.equal(a.approval?.independent, false);
    assert.equal(a.approval?.vendor_separation, "fail");
    assert.match(run(same, [HEAD]).out, /independent vendor \(vendor-separation\): NO/);
    const c = ans(changes, HEAD);
    assert.equal(c.approval?.independent_approval_at_head, "fail");
    assert.match(c.approval?.reasons.join("\n") ?? "", /CHANGES_REQUESTED/);
  } finally { rmSync(same, { recursive: true, force: true }); rmSync(changes, { recursive: true, force: true }); }
});

test("a failed required check is reported with the producer's reason and no checks are claimed as passed", () => {
  const dir = fixture({ "a.jsonl": audit({ failingCheck: "DCO" }) });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.checks?.result, "fail");
    assert.deepEqual(a.checks?.passed, []);
    assert.match(a.checks?.failure_reasons.join("\n") ?? "", /DCO/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every record the real control-audit.ts emits is read (none skipped as unrecognised)", () => {
  const text = audit();
  const dir = fixture({ "control-evidence.jsonl": text });
  try {
    const a = ans(dir, HEAD);
    assert.deepEqual(a.warnings, []);
    // 6 per-PR controls carry the PR head; the branch-protection record carries no sha
    assert.equal(a.checks?.controls.length, 6);
    assert.equal(text.trimEnd().split("\n").length, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed JSONL line is a warning and does not hide the good records", () => {
  const dir = fixture({ "a.jsonl": `not json\n${audit()}[1,2]\n` });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.found, true);
    assert.equal(a.warnings.length, 2);
    assert.match(a.warnings[0] ?? "", /a\.jsonl:1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ambiguous sha prefix is a usage error, not a guess", () => {
  const dir = fixture({ "a.jsonl": controlAuditJsonl([{ pr: 1, head: "abcdef1" + "0".repeat(33) }, { pr: 2, head: "abcdef1" + "1".repeat(33) }]) });
  try {
    const t = run(dir, ["abcdef1"]);
    assert.equal(t.code, 2);
    assert.match(t.err, /ambiguous/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage errors exit 2: no query, no --evidence, unreadable dir", () => {
  const dir = fixture(FULL);
  try {
    assert.equal(main([], { out: () => undefined, err: () => undefined }), 2);
    assert.equal(main([HEAD], { out: () => undefined, err: () => undefined }), 2);
    assert.equal(run(join(dir, "does-not-exist"), [HEAD]).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI entry point runs under node and exits non-zero with no evidence", () => {
  const dir = fixture(FULL);
  try {
    const script = fileURLToPath(new URL("../scripts/audit-query.ts", import.meta.url));
    const ok = spawnSync(process.execPath, [script, HEAD, "--evidence", dir, "--json"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((JSON.parse(ok.stdout) as Answer).found, true);
    const none = spawnSync(process.execPath, [script, OTHER, "--evidence", dir], { encoding: "utf8" });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /NO EVIDENCE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- #69: actors recorded by control-audit ------------------------------------------------------

const withMerge = {
  "control-audit.jsonl": audit({ mergeSha: MERGE }),
  "v0.1.0/release-evidence.json": releaseEvidence,
  "verify-release-evidence.json": verifyEvidence("pass", "2026-11-05T12:00:00.000Z"),
};

test("#69 a recorded merge commit links the PR, its author and reviewer to the release in both directions", () => {
  const dir = fixture(withMerge);
  try {
    const byHead = ans(dir, HEAD);
    assert.equal(byHead.change?.merge_sha, MERGE);
    assert.equal(byHead.release?.tag, "v0.1.0");
    for (const q of [MERGE, MERGE.slice(0, 8), "v0.1.0"]) {
      const a = ans(dir, q);
      assert.equal(a.change?.pr, 49, q);
      assert.equal(a.change?.head_sha, HEAD, q);
      assert.equal(a.change?.author_vendor, "claude", q);
      assert.equal(a.approval?.reviewer, "ruzni-reviewer", q);
      assert.equal(a.release?.sha256, DIGEST, q);
      assert.equal(a.checks?.head_sha, HEAD, q);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#69 records written before actors existed are still read; the identity fields are null, never guessed", () => {
  const stripped = audit({ mergeSha: MERGE }).trimEnd().split("\n").map((l) => { const o = JSON.parse(l) as Record<string, unknown>; delete o.actors; return JSON.stringify(o); }).join("\n");
  const dir = fixture({ "control-audit.jsonl": stripped });
  try {
    const a = ans(dir, HEAD);
    assert.deepEqual(a.warnings, []);
    assert.equal(a.checks?.result, "pass");
    assert.deepEqual(a.checks?.passed, ["DCO", "gate", "security-fast", "test-integrity"]);
    assert.deepEqual([a.change?.merge_sha, a.change?.author, a.change?.author_vendor, a.approval?.reviewer, a.approval?.reviewer_vendor, a.checks?.conclusions], [null, null, null, null, null, null]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#69 a failed check shows its conclusion beside the producer's reason", () => {
  const dir = fixture({ "a.jsonl": audit({ failingCheck: "DCO" }) });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.checks?.conclusions?.DCO, "failure");
    assert.equal(a.checks?.conclusions?.gate, "success");
    assert.deepEqual(a.checks?.passed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
