import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_ASSET, SCHEMA, SUMS_ASSET, findingTitle, parseSums, sha256, verifyAll } from "../scripts/verify-release.ts";
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
