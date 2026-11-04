import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidence, answer, main, SCHEMA } from "../scripts/audit-query.ts";
import type { Answer } from "../scripts/audit-query.ts";

const HEAD = "a".repeat(39) + "1";
const MERGE = "b".repeat(39) + "2";
const OTHER = "c".repeat(40);
const DIGEST = "d".repeat(64);

const rec = (control: string, o: Record<string, unknown> = {}): string => JSON.stringify({
  pr: 49, head_sha: HEAD, merge_sha: MERGE, author_vendor: "claude", reviewer: "ruzni-reviewer", reviewer_vendor: "codex",
  checks: { gate: "pass", "security-fast": "pass", DCO: "pass" },
  control: { id: control, catalog: "FINOS SDLC Common Controls", result: "pass" }, ...o,
});

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
  "control-audit.jsonl": `${rec("SDLC-PREV-007")}\n\n${rec("SDLC-PREV-008")}\n`,
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
    assert.deepEqual(a.change, { pr: 49, head_sha: HEAD, merge_sha: MERGE, author_vendor: "claude" });
    assert.deepEqual(a.approval, { reviewer: "ruzni-reviewer", reviewer_vendor: "codex", independent: true });
    assert.deepEqual(a.checks?.passed, ["DCO", "gate", "security-fast"]);
    assert.deepEqual(a.checks?.failed, []);
    assert.equal(a.checks?.controls.length, 2);
    assert.equal(a.release?.sha256, DIGEST);
    assert.deepEqual(a.release?.approved_by, ["RuzniSadiq"]);
    assert.equal(a.verification?.reverified, true);
    assert.equal(a.verification?.result, "pass");
    assert.equal(a.verification?.since_release, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("merge sha, short prefix and tag all resolve to the same change and release", () => {
  const dir = fixture(FULL);
  try {
    for (const q of [MERGE, HEAD.slice(0, 8), "v0.1.0"]) {
      const a = ans(dir, q);
      assert.equal(a.found, true, q);
      assert.equal(a.change?.head_sha, HEAD, q);
      assert.equal(a.release?.tag, "v0.1.0", q);
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
    assert.equal(parsed.release?.artefact, "task-management-0.1.0.tgz");
    const t = run(dir, [HEAD]);
    assert.equal(t.code, 0);
    for (const s of ["1. Who", "2. Who approved", "3. Which checks", "4. What was released", "5. Re-verified"]) assert.match(t.out, new RegExp(s));
    assert.match(t.out, /independent of author: yes/);
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
  const dir = fixture({ "control-audit.jsonl": rec("SDLC-PREV-007") + "\n" });
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

test("same vendor, or an unknown vendor, is NOT independent", () => {
  for (const o of [{ reviewer_vendor: "Claude" }, { reviewer_vendor: null }, { author_vendor: null }]) {
    const dir = fixture({ "a.jsonl": rec("SDLC-PREV-007", o) + "\n" });
    try {
      assert.equal(ans(dir, HEAD).approval?.independent, false, JSON.stringify(o));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a failed check is listed as failed and not as passed", () => {
  const dir = fixture({ "a.jsonl": rec("SDLC-PREV-007", { checks: { gate: "pass", DCO: "fail" } }) + "\n" });
  try {
    const a = ans(dir, HEAD);
    assert.deepEqual(a.checks?.passed, ["gate"]);
    assert.deepEqual(a.checks?.failed, ["DCO"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed JSONL line is a warning and does not hide the good records", () => {
  const dir = fixture({ "a.jsonl": `not json\n${rec("SDLC-PREV-007")}\n[1,2]\n` });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.found, true);
    assert.equal(a.warnings.length, 2);
    assert.match(a.warnings[0] ?? "", /a\.jsonl:1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ambiguous sha prefix is a usage error, not a guess", () => {
  const dir = fixture({ "a.jsonl": `${rec("X", { head_sha: "abcdef1" + "0".repeat(33) })}\n${rec("X", { head_sha: "abcdef1" + "1".repeat(33), merge_sha: null })}\n` });
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
