import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvidence, answer, main, SCHEMA } from "../scripts/audit-query.ts";
import type { Answer } from "../scripts/audit-query.ts";

// Adversarial cases for issue #42 (audit-query). The happy path lives in audit-query.test.ts.
//
// AC map (criterion -> test):
//   AC1 reads only --evidence files, no live calls  -> "source makes no network/gh/git calls", "evidence dir is never modified"
//   AC2 five answers in text and --json             -> audit-query.test.ts (all five), plus conflicting-checks / approver cases here
//   AC3 non-zero + explicit "no evidence"           -> sha-prefix edges, tag-only / skipped-only cases here
//   AC4 fixtures incl. missing-evidence             -> audit-query.test.ts, plus the nested / symlink / huge-input fixtures here

const HEAD = "a".repeat(39) + "1";
const MERGE = "b".repeat(39) + "2";
const DIGEST = "d".repeat(64);

const rec = (o: Record<string, unknown> = {}): string => JSON.stringify({
  pr: 49, head_sha: HEAD, merge_sha: MERGE, author_vendor: "claude", reviewer: "ruzni-reviewer", reviewer_vendor: "codex",
  checks: { gate: "pass" }, control: { id: "SDLC-PREV-007", catalog: "FINOS SDLC Common Controls", result: "pass" }, ...o,
});
const release = (o: Record<string, unknown> = {}): object => ({
  schema: SCHEMA, event: "release.published", recorded_at: "2026-11-05T10:00:00.000Z",
  artefact: { name: "task-management-0.1.0.tgz", sha256: DIGEST, tag: "v0.1.0", commit: MERGE },
  triggered_by: "RuzniSadiq", approvals: [{ login: "RuzniSadiq", state: "approved", comment: "ok" }], checks: { test: "pass" }, ...o,
});
const verify = (tags: { tag: string; result: string }[], at = "2026-11-05T12:00:00.000Z", skipped: { tag: string; reason: string }[] = []): object => ({
  schema: SCHEMA, event: "release.verified", recorded_at: at, result: "pass", releases: tags, skipped,
});

function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-query-adv-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
const cleanup = (dir: string): void => rmSync(dir, { recursive: true, force: true });

function run(argv: string[]): { out: string; err: string; code: number } {
  let out = "";
  let err = "";
  const code = main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { out, err, code };
}
const query = (dir: string, q: string, extra: string[] = []) => run([q, "--evidence", dir, ...extra]);

function ans(dir: string, q: string): Answer {
  const a = answer(loadEvidence(dir), q);
  assert.ok(!("ambiguous" in a));
  return a;
}

// ---- AC1: evidence only ----------------------------------------------------------------------

test("source makes no network, gh, git or subprocess calls", () => {
  const src = readFileSync(new URL("../scripts/audit-query.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  for (const banned of [/node:(child_process|http|https|http2|net|tls|dgram|dns)/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bexecSync\b|\bspawn(Sync)?\b|\bexecFile/, /\bgh\s+(api|pr|run)\b/]) {
    assert.doesNotMatch(code, banned);
  }
});

test("evidence dir is never modified by a query", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n", "r/release-evidence.json": release(), "v.json": verify([{ tag: "v0.1.0", result: "pass" }]) });
  const snap = (): string => JSON.stringify(["a.jsonl", "r/release-evidence.json", "v.json"].map((f) => readFileSync(join(dir, f), "utf8")))
    + JSON.stringify(readdirSync(dir, { recursive: true }).sort());
  try {
    const before = snap();
    assert.equal(query(dir, HEAD).code, 0);
    assert.equal(query(dir, "v0.1.0", ["--json"]).code, 0);
    assert.equal(snap(), before);
  } finally { cleanup(dir); }
});

// ---- AC3: sha prefix edges --------------------------------------------------------------------

test("sha prefix: 6 chars is below the minimum and finds nothing; 7 chars finds the change", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n" });
  try {
    assert.equal(query(dir, HEAD.slice(0, 6)).code, 1);
    assert.equal(query(dir, HEAD.slice(0, 7)).code, 0);
    assert.equal(query(dir, HEAD.slice(0, 7).toUpperCase()).code, 0);
  } finally { cleanup(dir); }
});

test("sha prefix: 7+ non-hex characters never match a commit", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n" });
  try {
    for (const q of ["zzzzzzz", "aaaaaaag", "aaaaaaa!"]) assert.equal(query(dir, q).code, 1, q);
  } finally { cleanup(dir); }
});

test("sha prefix: matching a merge sha resolves to that change, and uppercase evidence still matches", () => {
  const dir = fixture({ "a.jsonl": rec({ head_sha: HEAD.toUpperCase(), merge_sha: MERGE.toUpperCase() }) + "\n" });
  try {
    assert.equal(ans(dir, MERGE.slice(0, 9)).change?.pr, 49);
    assert.equal(ans(dir, HEAD).found, true);
  } finally { cleanup(dir); }
});

test("sha prefix: one record's head and another's merge sharing a prefix is ambiguous, not a guess", () => {
  const dir = fixture({ "a.jsonl": [
    rec({ pr: 1, head_sha: "abcdef1" + "0".repeat(33), merge_sha: null }),
    rec({ pr: 2, head_sha: "9".repeat(40), merge_sha: "abcdef1" + "2".repeat(33) }),
  ].join("\n") + "\n" });
  try {
    const t = query(dir, "abcdef1");
    assert.equal(t.code, 2);
    assert.match(t.err, /ambiguous/);
    // a longer prefix disambiguates
    assert.equal(query(dir, "abcdef10").code, 0);
  } finally { cleanup(dir); }
});

test("sha prefix: the same sha seen in the audit record and the release is not 'ambiguous'", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n", "r.json": release() });
  try {
    const a = ans(dir, MERGE.slice(0, 7));
    assert.equal(a.release?.tag, "v0.1.0");
    assert.equal(a.change?.head_sha, HEAD);
  } finally { cleanup(dir); }
});

// ---- AC3/AC2: tag-only and partial verify evidence --------------------------------------------

test("tag with only verify-release evidence: found, no change/release, verification reported", () => {
  const dir = fixture({ "v.json": verify([{ tag: "v0.1.0", result: "fail" }]) });
  try {
    const a = ans(dir, "v0.1.0");
    assert.equal(a.found, true);
    assert.equal(a.change, null);
    assert.equal(a.release, null);
    assert.equal(a.verification?.result, "fail");
    const t = query(dir, "v0.1.0");
    assert.equal(t.code, 0);
    assert.match(t.out, /4\. What was released[^\n]*\n\s+no evidence/);
    assert.match(t.out, /FAIL/);
  } finally { cleanup(dir); }
});

test("verify evidence for a different tag is not attached to this release", () => {
  const dir = fixture({ "r.json": release(), "v.json": verify([{ tag: "v0.2.0", result: "pass" }]) });
  try {
    const a = ans(dir, "v0.1.0");
    assert.equal(a.verification?.reverified, false);
    assert.equal(query(dir, "v0.2.0").code, 0);
  } finally { cleanup(dir); }
});

test("a tag that was only SKIPPED by verify-release was not re-verified", () => {
  const dir = fixture({ "v.json": verify([], undefined, [{ tag: "v0.3.0", reason: "draft (not published)" }]) });
  try {
    assert.equal(query(dir, "v0.3.0").code, 1);
  } finally { cleanup(dir); }
});

test("a verification older than the release record is flagged, not presented as 'since'", () => {
  const dir = fixture({ "r.json": release(), "v.json": verify([{ tag: "v0.1.0", result: "pass" }], "2026-11-01T00:00:00.000Z") });
  try {
    assert.equal(ans(dir, "v0.1.0").verification?.since_release, false);
    assert.match(query(dir, "v0.1.0").out, /older than the release record/);
  } finally { cleanup(dir); }
});

test("release approvals that are not 'approved' do not count as approvers", () => {
  const dir = fixture({ "r.json": release({ approvals: [{ login: "mallory", state: "rejected" }, { login: "", state: "approved" }, "junk", null] }) });
  try {
    assert.deepEqual(ans(dir, "v0.1.0").release?.approved_by, []);
    assert.match(query(dir, "v0.1.0").out, /no approver recorded/);
  } finally { cleanup(dir); }
});

// ---- duplicates / conflicts -------------------------------------------------------------------

test("two release records for one tag with different digests: the conflict is surfaced, not silently resolved", () => {
  const other = release({ artefact: { name: "task-management-0.1.0.tgz", sha256: "e".repeat(64), tag: "v0.1.0", commit: MERGE } });
  const dir = fixture({ "a/release-evidence.json": release(), "b/release-evidence.json": other });
  try {
    const a = ans(dir, "v0.1.0");
    assert.ok(a.warnings.some((w) => /v0\.1\.0/.test(w) && /conflict|multiple|duplicate/i.test(w)), JSON.stringify(a.warnings));
    assert.match(query(dir, "v0.1.0").out, /warning:.*v0\.1\.0/);
  } finally { cleanup(dir); }
});

test("identical duplicate release records (same digest) do not raise a conflict", () => {
  const dir = fixture({ "a/release-evidence.json": release(), "b/release-evidence.json": release() });
  try {
    assert.deepEqual(ans(dir, "v0.1.0").warnings, []);
  } finally { cleanup(dir); }
});

test("a check that passed in one control record but failed in another at the same head is reported failed", () => {
  const dir = fixture({ "a.jsonl": [rec({ checks: { gate: "pass", DCO: "pass" } }), rec({ checks: { gate: "fail" } })].join("\n") + "\n" });
  try {
    const a = ans(dir, HEAD);
    assert.deepEqual(a.checks?.failed, ["gate"]);
    assert.deepEqual(a.checks?.passed, ["DCO"]);
  } finally { cleanup(dir); }
});

test("non-'pass' check values (pending, null, numbers) count as not passed", () => {
  const dir = fixture({ "a.jsonl": rec({ checks: { a: "pass", b: "pending", c: null, d: 1, e: "PASS" } }) + "\n" });
  try {
    const a = ans(dir, HEAD);
    assert.deepEqual(a.checks?.passed, ["a"]);
    assert.deepEqual(a.checks?.failed, ["b", "c", "d", "e"]);
  } finally { cleanup(dir); }
});

// ---- file-system shapes -----------------------------------------------------------------------

test("deeply nested evidence is found", () => {
  const dir = fixture({ "a/b/c/d/e/f/g/audit.jsonl": rec() + "\n" });
  try {
    assert.equal(query(dir, HEAD).code, 0);
  } finally { cleanup(dir); }
});

test("a symlinked evidence subdirectory is followed", () => {
  const real = fixture({ "audit.jsonl": rec() + "\n" });
  const dir = fixture({});
  try {
    symlinkSync(real, join(dir, "linked"), "dir");
    assert.equal(query(dir, HEAD).code, 0);
  } finally { cleanup(dir); cleanup(real); }
});

test("a symlink loop terminates with a clean usage-style error, never a hang or stack trace", () => {
  const dir = fixture({ "audit.jsonl": rec() + "\n" });
  try {
    symlinkSync(dir, join(dir, "loop"), "dir");
    const t = query(dir, HEAD);
    assert.ok(t.code === 0 || t.code === 2, `exit ${t.code}`);
    assert.doesNotMatch(t.err, /\n\s+at /);
  } finally { cleanup(dir); }
});

test("a dangling symlink does not hide the good evidence next to it", () => {
  const dir = fixture({ "audit.jsonl": rec() + "\n" });
  try {
    symlinkSync(join(dir, "nowhere.json"), join(dir, "dangling.json"));
    const t = query(dir, HEAD);
    assert.equal(t.code, 0, t.err);
  } finally { cleanup(dir); }
});

test("--evidence pointing at a file, not a directory, is a usage error", () => {
  const dir = fixture({ "audit.jsonl": rec() + "\n" });
  try {
    const t = run([HEAD, "--evidence", join(dir, "audit.jsonl")]);
    assert.equal(t.code, 2);
    assert.match(t.err, /cannot read evidence dir/);
  } finally { cleanup(dir); }
});

test("non-evidence files are ignored; bad JSON is a warning; foreign-schema JSON is silent", () => {
  const dir = fixture({
    "notes.txt": "hello", "broken.json": "{not json", "other.json": { schema: "something/else", event: "release.published" },
    "unknown-event.json": { schema: SCHEMA, event: "release.exploded" }, "audit.jsonl": rec() + "\n",
  });
  try {
    const a = ans(dir, HEAD);
    assert.equal(a.found, true);
    assert.deepEqual(a.warnings, ["broken.json: not valid JSON (skipped)"]);
  } finally { cleanup(dir); }
});

test("JSONL tolerates CRLF, blank lines, a missing trailing newline and non-string head_sha", () => {
  const dir = fixture({ "a.jsonl": `${rec()}\r\n\r\n${JSON.stringify({ head_sha: 5 })}\r\n${rec({ pr: 50, head_sha: "f".repeat(40), merge_sha: null })}` });
  try {
    assert.equal(ans(dir, HEAD).found, true);
    assert.equal(ans(dir, "f".repeat(40)).change?.pr, 50);
    assert.equal(ans(dir, HEAD).warnings.length, 1);
  } finally { cleanup(dir); }
});

test("huge JSONL (100k records) is answered quickly and the one match is found", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    const sha = i.toString(16).padStart(40, "0");
    lines.push(JSON.stringify({ pr: i, head_sha: sha, merge_sha: null, author_vendor: "claude", checks: { gate: "pass" } }));
  }
  const dir = fixture({ "big.jsonl": lines.join("\n") + "\n" });
  try {
    const t0 = Date.now();
    const a = ans(dir, (77_777).toString(16).padStart(40, "0"));
    assert.equal(a.change?.pr, 77_777);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
    assert.equal(query(dir, "f".repeat(40)).code, 1);
  } finally { cleanup(dir); }
});

// ---- argument handling ------------------------------------------------------------------------

test("flag order does not matter, extra positionals and a flag-as-dir are usage errors", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n" });
  try {
    assert.equal(run(["--json", "--evidence", dir, HEAD]).code, 0);
    assert.equal(run(["--evidence", dir, HEAD, "--json"]).code, 0);
    assert.equal(run([HEAD, "extra", "--evidence", dir]).code, 2);
    assert.equal(run([HEAD, "--evidence", "--json"]).code, 2);
    assert.equal(run([HEAD, "--evidence"]).code, 2);
  } finally { cleanup(dir); }
});

test("a query that looks like a flag or path cannot escape the evidence dir", () => {
  const dir = fixture({ "a.jsonl": rec() + "\n" });
  try {
    for (const q of ["../../etc/passwd", "", " "]) {
      const t = query(dir, q);
      assert.notEqual(t.code, 0, JSON.stringify(q));
    }
  } finally { cleanup(dir); }
});
