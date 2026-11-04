import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_ASSET, FINDING_LABEL, SCHEMA, SUMS_ASSET, findingTitle, parseSums, sha256, verifyAll } from "../scripts/verify-release.ts";
import type { Asset, Evidence, Gh, Issue, ReleaseInfo } from "../scripts/verify-release.ts";

const TARBALL = "task-management-0.1.0.tgz";
const GOOD = Buffer.from("the approved tarball bytes");
const EVIL = Buffer.from("some other tarball");
const run = { url: "https://github.com/o/r/actions/runs/7", attempt: "1" };
const opts = { repo: "o/r", run, now: () => "2026-11-05T00:00:00.000Z" };

interface Files { [name: string]: Buffer }

let nextAssetId = 1;

/** A release whose assets are these files; asset ids are unique across all releases, as on GitHub. */
function release(tag: string, files: Files, draft = false): { info: ReleaseInfo; bytes: Map<number, Buffer> } {
  const bytes = new Map<number, Buffer>();
  const assets: Asset[] = Object.entries(files).map(([name, b]) => { const id = nextAssetId++; bytes.set(id, b); return { id, name }; });
  return { info: { tag, url: `https://github.com/o/r/releases/tag/${tag}`, draft, assets }, bytes };
}

const sumsFor = (b: Buffer, name = TARBALL): Buffer => Buffer.from(`${sha256(b)}  ${name}\n`);
const evidenceFor = (b: Buffer, name = TARBALL): Buffer => Buffer.from(JSON.stringify({ schema: SCHEMA, event: "release.published", artefact: { name, sha256: sha256(b), tag: "v0.1.0" } }));

/** The assets release.yml publishes, built from the approved bytes. */
const published = (served: Buffer = GOOD): Files => ({ [TARBALL]: served, [SUMS_ASSET]: sumsFor(GOOD), [EVIDENCE_ASSET]: evidenceFor(GOOD) });

interface Opts { attested?: Set<string>; open?: Issue[]; downloadFails?: Set<string> }

function fakeGh(releases: ReturnType<typeof release>[], o: Opts = {}) {
  const attested = o.attested ?? new Set([sha256(GOOD)]);
  const open: Issue[] = [...(o.open ?? [])];
  const created: { title: string; body: string }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const attestCalls: string[] = [];
  let labelEnsured = 0;
  let next = 100;
  const gh: Gh = {
    releases: () => releases.map((r) => r.info),
    download: (asset) => {
      if (o.downloadFails?.has(asset.name)) throw new Error("HTTP 502");
      for (const r of releases) { const b = r.bytes.get(asset.id); if (b !== undefined) return b; }
      throw new Error(`no asset ${asset.id}`);
    },
    attest: (name, bytes) => { attestCalls.push(name); return attested.has(sha256(bytes)) ? { ok: true, detail: "verified" } : { ok: false, detail: "no matching attestations found" }; },
    ensureLabel: () => { labelEnsured++; },
    openFindings: () => [...open],
    createIssue: (title, body) => { const n = next++; created.push({ title, body }); open.push({ number: n, title }); return n; },
    comment: (issue, body) => { comments.push({ issue, body }); },
  };
  return { gh, created, comments, attestCalls, labelEnsured: () => labelEnsured };
}

const only = (e: Evidence) => { const r = e.releases[0]; assert.ok(r); const a = r.artefacts[0]; assert.ok(a); return { r, a }; };
const control = (e: Evidence, id: string) => e.controls.find((c) => c.id === id)?.result;

test("clean pass: digests match both records, attestation verifies, no finding", () => {
  const f = fakeGh([release("v0.1.0", published())]);
  const e = verifyAll(f.gh, opts);
  assert.equal(e.schema, SCHEMA);
  assert.equal(e.event, "release.verified");
  assert.equal(e.result, "pass");
  const { r, a } = only(e);
  assert.equal(r.result, "pass");
  assert.deepEqual(a, { name: TARBALL, result: "pass", observed_sha256: sha256(GOOD), expected_sha256: { sha256sums: sha256(GOOD), release_evidence: sha256(GOOD) }, attestation: "pass", reasons: [] });
  assert.deepEqual(e.findings, []);
  assert.equal(f.created.length + f.comments.length + f.labelEnsured(), 0);
  assert.deepEqual(f.attestCalls, [TARBALL]);
  assert.deepEqual(e.controls.map((c) => [c.id, c.result]), [["SDLC-PREV-003", "pass"], ["SDLC-PREV-002", "pass"], ["OP-007", "pass"]]);
  assert.equal(e.run.url, run.url);
});

test("tampered asset: served bytes differ, observed vs expected digests recorded, finding opened", () => {
  const f = fakeGh([release("v0.1.0", published(EVIL))]);
  const e = verifyAll(f.gh, opts);
  assert.equal(e.result, "fail");
  const { r, a } = only(e);
  assert.equal(r.result, "fail");
  assert.equal(a.observed_sha256, sha256(EVIL));
  assert.deepEqual(a.expected_sha256, { sha256sums: sha256(GOOD), release_evidence: sha256(GOOD) });
  assert.equal(a.attestation, "fail");
  assert.ok(a.reasons.some((x) => x.includes(`vs ${SUMS_ASSET}`) && x.includes(sha256(GOOD)) && x.includes(sha256(EVIL))));
  assert.ok(a.reasons.some((x) => x.includes(`vs ${EVIDENCE_ASSET}`)));
  assert.equal(control(e, "SDLC-PREV-002"), "fail");
  assert.equal(f.created.length, 1);
  const issue = f.created[0];
  assert.ok(issue);
  assert.equal(issue.title, findingTitle("v0.1.0"));
  for (const s of ["v0.1.0", sha256(GOOD), sha256(EVIL), run.url]) assert.ok(issue.body.includes(s), `finding body names ${s}`);
  assert.equal(f.labelEnsured(), 1);
  assert.deepEqual(e.findings, [{ tag: "v0.1.0", issue: 100, action: "opened" }]);
});

test("tampered asset with rewritten SHA256SUMS is still caught by release-evidence.json and attestation", () => {
  const files = { ...published(EVIL), [SUMS_ASSET]: sumsFor(EVIL) };
  const e = verifyAll(fakeGh([release("v0.1.0", files)]).gh, opts);
  const { a } = only(e);
  assert.equal(a.result, "fail");
  assert.equal(a.expected_sha256.sha256sums, sha256(EVIL));
  assert.ok(a.reasons.some((x) => x.includes(`vs ${EVIDENCE_ASSET}`)));
  assert.ok(!a.reasons.some((x) => x.includes(`vs ${SUMS_ASSET}`)));
  assert.equal(a.attestation, "fail");
});

test("Scenario C: an extra tarball uploaded with --clobber under another name fails the release", () => {
  const files = { ...published(), "other.tgz": EVIL };
  const f = fakeGh([release("v0.1.0", files)]);
  const e = verifyAll(f.gh, opts);
  assert.equal(e.result, "fail");
  const r = e.releases[0];
  assert.ok(r);
  const good = r.artefacts.find((a) => a.name === TARBALL);
  const other = r.artefacts.find((a) => a.name === "other.tgz");
  assert.equal(good?.result, "pass");
  assert.equal(other?.result, "fail");
  assert.ok(other.reasons.some((x) => x.includes(`${SUMS_ASSET} has no line for other.tgz`)));
  assert.ok(other.reasons.some((x) => x.includes(`not the artefact recorded in ${EVIDENCE_ASSET}`)));
  assert.equal(f.created.length, 1);
});

test("missing SHA256SUMS fails the release and its tarball, and is named in the finding", () => {
  const files = published();
  delete files[SUMS_ASSET];
  const f = fakeGh([release("v0.1.0", files)]);
  const e = verifyAll(f.gh, opts);
  assert.equal(e.result, "fail");
  const { r, a } = only(e);
  assert.equal(r.result, "fail");
  assert.deepEqual(r.reasons, [`release has no ${SUMS_ASSET} asset`]);
  assert.equal(a.result, "fail");
  assert.equal(a.expected_sha256.sha256sums, null);
  assert.equal(a.expected_sha256.release_evidence, sha256(GOOD));
  assert.equal(control(e, "SDLC-PREV-002"), "fail");
  assert.ok(f.created[0]?.body.includes(`release has no ${SUMS_ASSET} asset`));
});

test("missing or unreadable release-evidence.json fails the release", () => {
  const missing = published();
  delete missing[EVIDENCE_ASSET];
  const e1 = verifyAll(fakeGh([release("v0.1.0", missing)]).gh, opts);
  assert.deepEqual(only(e1).r.reasons, [`release has no ${EVIDENCE_ASSET} asset`]);
  assert.equal(e1.result, "fail");
  const garbled = { ...published(), [EVIDENCE_ASSET]: Buffer.from("{not json") };
  const e2 = verifyAll(fakeGh([release("v0.1.0", garbled)]).gh, opts);
  assert.equal(e2.result, "fail");
  assert.deepEqual(only(e2).r.reasons, [`${EVIDENCE_ASSET} is not valid JSON`]);
});

test("attestation failure alone fails the release with digests still passing", () => {
  const f = fakeGh([release("v0.1.0", published())], { attested: new Set() });
  const e = verifyAll(f.gh, opts);
  assert.equal(e.result, "fail");
  const { a } = only(e);
  assert.equal(a.attestation, "fail");
  assert.equal(a.observed_sha256, sha256(GOOD));
  assert.deepEqual(a.reasons, [`attestation verify failed for ${TARBALL}: no matching attestations found`]);
  assert.equal(control(e, "SDLC-PREV-003"), "fail");
  assert.equal(control(e, "SDLC-PREV-002"), "pass");
  assert.equal(f.created.length, 1);
});

test("an attestation call that throws is a failure, not a crash", () => {
  const f = fakeGh([release("v0.1.0", published())]);
  f.gh.attest = () => { throw new Error("gh: command not found"); };
  const { a } = only(verifyAll(f.gh, opts));
  assert.equal(a.attestation, "fail");
  assert.equal(a.result, "fail");
});

test("download failure of the tarball fails closed with attestation not run", () => {
  const f = fakeGh([release("v0.1.0", published())], { downloadFails: new Set([TARBALL]) });
  const e = verifyAll(f.gh, opts);
  const { a } = only(e);
  assert.equal(a.result, "fail");
  assert.equal(a.observed_sha256, null);
  assert.equal(a.attestation, "not-run");
  assert.equal(control(e, "SDLC-PREV-003"), "fail");
});

test("dedupe: an open finding for the release gets a comment, not a second issue", () => {
  const f = fakeGh([release("v0.1.0", published(EVIL))], { open: [{ number: 41, title: findingTitle("v0.1.0") }, { number: 9, title: findingTitle("v0.0.9") }] });
  const e = verifyAll(f.gh, opts);
  assert.equal(f.created.length, 0);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0]?.issue, 41);
  assert.ok(f.comments[0]?.body.includes(sha256(EVIL)));
  assert.deepEqual(e.findings, [{ tag: "v0.1.0", issue: 41, action: "commented" }]);
});

test("dedupe across runs: second failing run comments on the issue the first run opened", () => {
  const releases = [release("v0.1.0", published(EVIL))];
  const first = fakeGh(releases);
  verifyAll(first.gh, opts);
  assert.equal(first.created.length, 1);
  const second = fakeGh(releases, { open: [{ number: 100, title: first.created[0]?.title ?? "" }] });
  verifyAll(second.gh, opts);
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.comments.map((c) => c.issue), [100]);
});

test("one finding per failing release; passing releases and drafts/no-tarball releases are skipped", () => {
  const f = fakeGh([
    release("v0.2.0", published(EVIL)),
    release("v0.1.0", published()),
    release("v0.3.0", published(EVIL), true),
    release("v0.0.1", { "notes.txt": Buffer.from("x") }),
  ]);
  const e = verifyAll(f.gh, opts);
  assert.deepEqual(e.releases.map((r) => [r.tag, r.result]), [["v0.2.0", "fail"], ["v0.1.0", "pass"]]);
  assert.deepEqual(f.created.map((c) => c.title), [findingTitle("v0.2.0")]);
  assert.equal(e.result, "fail");
});

test("no releases with a tarball is a pass with nothing to report", () => {
  const e = verifyAll(fakeGh([]).gh, opts);
  assert.equal(e.result, "pass");
  assert.deepEqual(e.releases, []);
});

test("parseSums reads sha256sum text and binary-mode lines and ignores junk", () => {
  const h = "A".repeat(64);
  const m = parseSums(`${h}  a.tgz\n${"b".repeat(64)} *b.tgz\nnot a line\n\n`);
  assert.deepEqual([...m], [["a.tgz", "a".repeat(64)], ["b.tgz", "b".repeat(64)]]);
});

// ---------------------------------------------------------------------------------------------
// Test-engineer sensors (PR #44): adversarial inputs, the workflow contract (AC1/AC3) and the CLI
// end to end through ghCli with a fake `gh` on PATH (AC3/AC4: evidence file, exit code, issue I/O).
// ---------------------------------------------------------------------------------------------

test("evidence naming a tarball that is not in the release fails the release", () => {
  const files = { "renamed.tgz": GOOD, [SUMS_ASSET]: sumsFor(GOOD, "renamed.tgz"), [EVIDENCE_ASSET]: evidenceFor(GOOD) };
  const e = verifyAll(fakeGh([release("v0.1.0", files)]).gh, opts);
  const { r, a } = only(e);
  assert.equal(r.result, "fail");
  assert.ok(r.reasons.some((x) => x.includes(`released artefact ${TARBALL} named in ${EVIDENCE_ASSET} is missing`)));
  assert.equal(a.result, "fail");
  assert.equal(control(e, "SDLC-PREV-002"), "fail");
});

test("release-evidence.json with a non-hex digest, null, or no artefact fails closed without throwing", () => {
  for (const text of [
    JSON.stringify({ artefact: { name: TARBALL, sha256: "deadbeef" } }),
    JSON.stringify({ artefact: { name: TARBALL, sha256: sha256(GOOD).replace(/^./, "g") } }),
    "null",
    "[]",
    JSON.stringify({ artefact: { name: 7, sha256: sha256(GOOD) } }),
  ]) {
    const files = { ...published(), [EVIDENCE_ASSET]: Buffer.from(text) };
    const e = verifyAll(fakeGh([release("v0.1.0", files)]).gh, opts);
    const { r, a } = only(e);
    assert.equal(r.result, "fail", text);
    assert.deepEqual(r.reasons, [`${EVIDENCE_ASSET} has no artefact.name/artefact.sha256`], text);
    assert.equal(a.expected_sha256.release_evidence, null, text);
    assert.equal(control(e, "SDLC-PREV-002"), "fail", text);
  }
});

test("uppercase digests in SHA256SUMS and release-evidence.json still match", () => {
  const files = {
    ...published(),
    [SUMS_ASSET]: Buffer.from(`${sha256(GOOD).toUpperCase()}  ${TARBALL}\n`),
    [EVIDENCE_ASSET]: Buffer.from(JSON.stringify({ artefact: { name: TARBALL, sha256: sha256(GOOD).toUpperCase() } })),
  };
  assert.equal(verifyAll(fakeGh([release("v0.1.0", files)]).gh, opts).result, "pass");
});

test("SHA256SUMS that exists but cannot be downloaded fails the release with the reason", () => {
  const f = fakeGh([release("v0.1.0", published())], { downloadFails: new Set([SUMS_ASSET]) });
  const e = verifyAll(f.gh, opts);
  const { r, a } = only(e);
  assert.equal(r.result, "fail");
  assert.deepEqual(r.reasons, [`could not download ${SUMS_ASSET}: HTTP 502`]);
  assert.equal(a.result, "fail");
  assert.ok(f.created[0]?.body.includes(`could not download ${SUMS_ASSET}`));
});

test("SHA256SUMS lines for other files do not vouch for the tarball", () => {
  const files = { ...published(), [SUMS_ASSET]: Buffer.from(`${sha256(GOOD)}  ${TARBALL}.bak\n${sha256(GOOD)}  x/${TARBALL}\n`) };
  const { a } = only(verifyAll(fakeGh([release("v0.1.0", files)]).gh, opts));
  assert.equal(a.result, "fail");
  assert.equal(a.expected_sha256.sha256sums, null);
  assert.ok(a.reasons.includes(`${SUMS_ASSET} has no line for ${TARBALL}`));
});

test("dedupe is by exact title: a finding for a similar tag is not reused", () => {
  const f = fakeGh([release("v0.1.0", published(EVIL))], { open: [{ number: 5, title: findingTitle("v0.1.0-rc1") }, { number: 6, title: findingTitle("v0.1.0").toUpperCase() }] });
  const e = verifyAll(f.gh, opts);
  assert.equal(f.comments.length, 0);
  assert.deepEqual(f.created.map((c) => c.title), [findingTitle("v0.1.0")]);
  assert.deepEqual(e.findings, [{ tag: "v0.1.0", issue: 100, action: "opened" }]);
});

test("two failing releases in one run open two distinct findings", () => {
  const f = fakeGh([release("v0.2.0", published(EVIL)), release("v0.1.0", published(EVIL))]);
  const e = verifyAll(f.gh, opts);
  assert.deepEqual(f.created.map((c) => c.title), [findingTitle("v0.2.0"), findingTitle("v0.1.0")]);
  assert.deepEqual(e.findings.map((x) => [x.tag, x.action]), [["v0.2.0", "opened"], ["v0.1.0", "opened"]]);
  assert.equal(f.labelEnsured(), 1);
});

// ---- AC1 / AC3: the workflow file itself ------------------------------------------------------

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/verify-release.yml", import.meta.url)), "utf8");

test("AC1: workflow triggers on a daily schedule, workflow_dispatch and release published/edited", () => {
  assert.match(workflow, /^on:\n {2}schedule:\n {4}- cron: "\d{1,2} \d{1,2} \* \* \*"\n {2}workflow_dispatch:\n {2}release:\n {4}types: \[published, edited\]\n/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test("AC1: every action is pinned by a full commit SHA", () => {
  const uses = workflow.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 3, "checkout, setup-node, upload-artifact");
  for (const l of uses) assert.match(l, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s|$)/, l);
});

test("AC1: permissions are empty at workflow level and exactly contents/attestations read + issues write on the job", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const block = /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(workflow)?.[1];
  assert.ok(block !== undefined, "job-level permissions block");
  assert.deepEqual(block.trim().split("\n").map((l) => l.trim()).sort(), ["attestations: read", "contents: read", "issues: write"]);
  assert.equal(workflow.match(/permissions:/g)?.length, 2, "no other permissions grants");
  assert.doesNotMatch(workflow, /secrets\./, "only the job's github.token is used");
  assert.match(workflow, /persist-credentials: false/);
});

test("AC3: the job runs the script and always uploads verify-release-evidence.json as an artifact", () => {
  assert.match(workflow, /run: node scripts\/verify-release\.ts --repo "\$GITHUB_REPOSITORY" --out verify-release-evidence\.json/);
  assert.match(workflow, /- uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n {8}if: always\(\)\n {8}with:\n(?: {10}.*\n)*? {10}path: verify-release-evidence\.json\n/);
});

// ---- AC3 / AC4: the CLI end to end, real ghCli against a fake `gh` -----------------------------

const SCRIPT = fileURLToPath(new URL("../scripts/verify-release.ts", import.meta.url));

/** A stand-in `gh` (CommonJS, Node builtins only) driven by a JSON state file; it logs every call. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const a = process.argv.slice(2);
const log = (stdin) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: a, stdin }) + "\\n");
function main() {
  if (a[0] === "api" && a[1] === "--paginate") {
    log(null);
    if (st.failReleases) { process.stderr.write("HTTP 503: Service Unavailable\\n"); return 1; }
    process.stdout.write(st.releases.map((r) => JSON.stringify(r) + "\\n").join(""));
    return 0;
  }
  if (a[0] === "api" && a[1] === "-H") {
    log(null);
    const b64 = st.assets[a[3].split("/").pop()];
    if (b64 === undefined) { process.stderr.write("HTTP 404\\n"); return 1; }
    process.stdout.write(Buffer.from(b64, "base64"));
    return 0;
  }
  if (a[0] === "attestation" && a[1] === "verify") {
    log(null);
    const d = crypto.createHash("sha256").update(fs.readFileSync(a[2])).digest("hex");
    if (st.attested.includes(d)) { process.stdout.write("Verification succeeded!\\n"); return 0; }
    process.stderr.write("Error: no matching attestations found\\n");
    return 1;
  }
  if (a[0] === "label" && a[1] === "create") { log(null); return 0; }
  if (a[0] === "issue" && a[1] === "list") { log(null); process.stdout.write(JSON.stringify(st.open)); return 0; }
  if (a[0] === "issue" && (a[1] === "create" || a[1] === "comment")) {
    log(fs.readFileSync(0, "utf8"));
    if (a[1] === "create") process.stdout.write("https://github.com/o/r/issues/321\\n");
    return 0;
  }
  log(null);
  process.stderr.write("fake gh: unexpected call\\n");
  return 2;
}
process.exitCode = main();
`;

interface CliState { failReleases?: boolean; served?: Buffer; attested?: string[]; open?: Issue[] }
interface GhCall { args: string[]; stdin: string | null }

function runCli(s: CliState, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "verify-release-cli-"));
  try {
    const rel = release("v0.1.0", published(s.served ?? GOOD));
    const assets: Record<string, string> = {};
    for (const [id, b] of rel.bytes) assets[String(id)] = b.toString("base64");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      failReleases: s.failReleases ?? false,
      releases: [rel.info],
      assets,
      attested: s.attested ?? [sha256(GOOD)],
      open: s.open ?? [],
    }));
    writeFileSync(join(dir, "gh"), FAKE_GH, { mode: 0o755 });
    writeFileSync(join(dir, "calls.jsonl"), "");
    const out = join(dir, "evidence.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_STATE: join(dir, "state.json"),
      FAKE_GH_LOG: join(dir, "calls.jsonl"),
      GITHUB_RUN_ID: "4242",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
    };
    const p = spawnSync(process.execPath, [SCRIPT, "--repo", "o/r", "--out", out, ...extra], { env, encoding: "utf8" });
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as GhCall);
    const evidence = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as Evidence : undefined;
    return { status: p.status, stdout: p.stdout, stderr: p.stderr, calls, evidence };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUN_URL = "https://github.com/o/r/actions/runs/4242";
const writes = (calls: GhCall[]) => calls.filter((c) => c.args[0] === "label" || (c.args[0] === "issue" && c.args[1] !== "list"));

test("CLI clean pass: exit 0, evidence file written, no issue writes", () => {
  const r = runCli({});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.evidence);
  assert.equal(r.evidence.schema, SCHEMA);
  assert.equal(r.evidence.event, "release.verified");
  assert.equal(r.evidence.result, "pass");
  assert.deepEqual(r.evidence.run, { url: RUN_URL, attempt: "2" });
  assert.deepEqual(r.evidence.releases.map((x) => [x.tag, x.result]), [["v0.1.0", "pass"]]);
  assert.deepEqual(r.calls.filter((c) => c.args[0] === "attestation").map((c) => c.args.slice(3)), [["--repo", "o/r"]]);
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /PASS v0\.1\.0/);
});

test("CLI tampered asset: exit 1, evidence records the mismatch, finding opened with digests and run URL", () => {
  const r = runCli({ served: EVIL });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.evidence);
  assert.equal(r.evidence.result, "fail");
  const a = r.evidence.releases[0]?.artefacts[0];
  assert.equal(a?.observed_sha256, sha256(EVIL));
  assert.equal(a.expected_sha256.release_evidence, sha256(GOOD));
  assert.deepEqual(r.evidence.findings, [{ tag: "v0.1.0", issue: 321, action: "opened" }]);
  const create = r.calls.find((c) => c.args[0] === "issue" && c.args[1] === "create");
  assert.ok(create?.stdin);
  assert.deepEqual(create.args.slice(2, 8), ["--repo", "o/r", "--title", findingTitle("v0.1.0"), "--label", FINDING_LABEL]);
  for (const s of [sha256(GOOD), sha256(EVIL), RUN_URL]) assert.ok(create.stdin.includes(s), s);
  assert.ok(r.calls.some((c) => c.args[0] === "label" && c.args.includes(FINDING_LABEL)));
});

test("CLI repeat failing run comments on the open finding instead of opening another", () => {
  const r = runCli({ served: EVIL, open: [{ number: 77, title: findingTitle("v0.1.0") }] });
  assert.equal(r.status, 1);
  assert.equal(r.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").length, 0);
  const comment = r.calls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
  assert.equal(comment?.args[2], "77");
  assert.ok(comment.stdin?.includes(sha256(EVIL)));
  assert.deepEqual(r.evidence?.findings, [{ tag: "v0.1.0", issue: 77, action: "commented" }]);
});

test("CLI attestation failure via real gh exit status: exit 1, attestation fail recorded", () => {
  const r = runCli({ attested: [] });
  assert.equal(r.status, 1);
  const a = r.evidence?.releases[0]?.artefacts[0];
  assert.equal(a?.attestation, "fail");
  assert.ok(a.reasons.some((x) => x.includes("no matching attestations found")));
});

test("CLI --dry-run on a failing release: exit 1 and evidence written, but no label, issue or comment writes", () => {
  const r = runCli({ served: EVIL, open: [{ number: 77, title: findingTitle("v0.1.0") }] }, ["--dry-run"]);
  assert.equal(r.status, 1);
  assert.equal(r.evidence?.result, "fail");
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /\[dry-run\] would open or comment/);
});

test("CLI cannot list releases: fails closed with a non-zero exit", () => {
  const r = runCli({ failReleases: true });
  assert.notEqual(r.status, 0);
  assert.deepEqual(writes(r.calls), []);
});
