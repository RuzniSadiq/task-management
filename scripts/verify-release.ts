// verify-release.ts — detective control for released artefacts (issue #40, Scenario C).
//
// release.yml is the preventive side: it gates, approves, attests and fingerprints each release.
// This script is the detective side. It runs on a schedule and after release events, and checks
// that what every published GitHub release serves still matches what was approved:
//   1. each tarball's sha256, recomputed from the downloaded bytes, equals its SHA256SUMS line
//   2. it also equals artefact.sha256 in the release's release-evidence.json
//   3. `gh attestation verify <tarball> --repo <repo>` succeeds (sigstore build provenance)
// Any failure exits non-zero and opens one `control-finding` issue per release, or comments on the
// one already open for that release, so repeat runs never duplicate it.
//
// FINOS controls evaluated here:
//   SDLC-PREV-003 Software Artifact Provenance   attestation still verifies for the served bytes
//   SDLC-PREV-002 Content Addressable IDs        served digest equals the recorded digests
//   OP-007        Monitoring                     the scheduled re-verification and its findings
//
// Usage (needs GH_TOKEN with contents:read, attestations:read, issues:write):
//   node scripts/verify-release.ts [--repo owner/name] [--out verify-release-evidence.json] [--dry-run]
// --dry-run verifies everything but writes no issue (read-only; findings are printed).
// All GitHub access goes through the Gh interface, so the tests run with no network.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SCHEMA = "task-management.control-evidence/v1";
export const FINDING_LABEL = "control-finding";
export const DEFAULT_REPO = "RuzniSadiq/task-management";
export const SUMS_ASSET = "SHA256SUMS";
export const EVIDENCE_ASSET = "release-evidence.json";

export interface Asset { id: number; name: string }
export interface ReleaseInfo { tag: string; url: string; draft: boolean; assets: Asset[] }
export interface Issue { number: number; title: string }

/** Every GitHub call the control makes. Methods throw on a gh failure. */
export interface Gh {
  releases(): ReleaseInfo[];
  download(asset: Asset): Buffer;
  /** Run `gh attestation verify` on these exact bytes, saved under `name`. */
  attest(name: string, bytes: Buffer): { ok: boolean; detail: string };
  ensureLabel(): void;
  openFindings(): Issue[];
  createIssue(title: string, body: string): number;
  comment(issue: number, body: string): void;
}

export type Result = "pass" | "fail";

export interface ArtefactResult {
  name: string;
  result: Result;
  observed_sha256: string | null;
  expected_sha256: { sha256sums: string | null; release_evidence: string | null };
  attestation: Result | "not-run";
  reasons: string[];
}

export interface ReleaseResult { tag: string; url: string; result: Result; artefacts: ArtefactResult[]; reasons: string[] }

export interface Run { url: string; attempt: string }

export interface Evidence {
  schema: typeof SCHEMA;
  event: "release.verified";
  recorded_at: string;
  repository: string;
  run: Run;
  result: Result;
  releases: ReleaseResult[];
  findings: { tag: string; issue: number; action: "opened" | "commented" }[];
  controls: { id: string; catalog?: string; version?: string; name: string; result: Result; evidence: string }[];
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const isTarball = (name: string): boolean => name.endsWith(".tgz");
const HEX64 = /^[0-9a-f]{64}$/;

/** Parse `sha256sum` output: `<hex>  <name>` (or `<hex> *<name>`). Malformed lines are ignored. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** The artefact name and digest recorded by release.yml, or the reason they cannot be read. */
export function parseEvidence(text: string): { name: string; sha256: string } | string {
  let rec: unknown;
  try { rec = JSON.parse(text); } catch { return `${EVIDENCE_ASSET} is not valid JSON`; }
  const artefact = (rec as { artefact?: { name?: unknown; sha256?: unknown } } | null)?.artefact;
  if (typeof artefact?.name !== "string" || typeof artefact.sha256 !== "string" || !HEX64.test(artefact.sha256.toLowerCase())) {
    return `${EVIDENCE_ASSET} has no artefact.name/artefact.sha256`;
  }
  return { name: artefact.name, sha256: artefact.sha256.toLowerCase() };
}

function fetchText(gh: Gh, assets: Asset[], name: string): { text: string } | { error: string } {
  const asset = assets.find((a) => a.name === name);
  if (asset === undefined) return { error: `release has no ${name} asset` };
  try { return { text: gh.download(asset).toString("utf8") }; } catch (e) { return { error: `could not download ${name}: ${errText(e)}` }; }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "";

/** Re-verify one release. Never throws: every problem becomes a failed result with a reason. */
export function verifyRelease(gh: Gh, rel: ReleaseInfo): ReleaseResult {
  const reasons: string[] = [];
  const sumsFile = fetchText(gh, rel.assets, SUMS_ASSET);
  const sums = "text" in sumsFile ? parseSums(sumsFile.text) : undefined;
  if ("error" in sumsFile) reasons.push(sumsFile.error);
  const evFile = fetchText(gh, rel.assets, EVIDENCE_ASSET);
  const evidence = "text" in evFile ? parseEvidence(evFile.text) : evFile.error;
  if (typeof evidence === "string") reasons.push(evidence);

  const tarballs = rel.assets.filter((a) => isTarball(a.name));
  if (typeof evidence !== "string" && !tarballs.some((a) => a.name === evidence.name)) {
    reasons.push(`released artefact ${evidence.name} named in ${EVIDENCE_ASSET} is missing from the release`);
  }

  const artefacts = tarballs.map((asset): ArtefactResult => {
    const why: string[] = [];
    const fromSums = sums?.get(asset.name) ?? null;
    if (sums !== undefined && fromSums === null) why.push(`${SUMS_ASSET} has no line for ${asset.name}`);
    let fromEvidence: string | null = null;
    if (typeof evidence !== "string") {
      if (evidence.name === asset.name) fromEvidence = evidence.sha256;
      else why.push(`${asset.name} is not the artefact recorded in ${EVIDENCE_ASSET} (${evidence.name})`);
    }
    let bytes: Buffer | undefined;
    try { bytes = gh.download(asset); } catch (e) { why.push(`could not download ${asset.name}: ${errText(e)}`); }
    const observed = bytes === undefined ? null : sha256(bytes);
    if (observed !== null && fromSums !== null && observed !== fromSums) {
      why.push(`digest mismatch vs ${SUMS_ASSET}: expected ${fromSums}, observed ${observed}`);
    }
    if (observed !== null && fromEvidence !== null && observed !== fromEvidence) {
      why.push(`digest mismatch vs ${EVIDENCE_ASSET}: expected ${fromEvidence}, observed ${observed}`);
    }
    let attestation: ArtefactResult["attestation"] = "not-run";
    if (bytes !== undefined) {
      let outcome: { ok: boolean; detail: string };
      try { outcome = gh.attest(asset.name, bytes); } catch (e) { outcome = { ok: false, detail: errText(e) }; }
      attestation = outcome.ok ? "pass" : "fail";
      if (!outcome.ok) why.push(`attestation verify failed for ${asset.name}: ${outcome.detail || "no detail"}`);
    }
    // Missing SHA256SUMS / evidence fail the release, so every tarball in it fails too.
    const result: Result = why.length === 0 && reasons.length === 0 ? "pass" : "fail";
    return { name: asset.name, result, observed_sha256: observed, expected_sha256: { sha256sums: fromSums, release_evidence: fromEvidence }, attestation, reasons: why };
  });

  const result: Result = reasons.length === 0 && artefacts.every((a) => a.result === "pass") ? "pass" : "fail";
  return { tag: rel.tag, url: rel.url, result, artefacts, reasons };
}

/** Title of the one open finding per release; dedupe is by exact title among open `control-finding` issues. */
export const findingTitle = (tag: string): string => `control-finding: release ${tag} failed re-verification`;

export function findingBody(r: ReleaseResult, run: Run): string {
  const lines = [
    `Release **${r.tag}** (${r.url}) failed re-verification by \`verify-release\`.`,
    "",
    `- Run: ${run.url}`,
    ...r.reasons.map((x) => `- ${x}`),
    "",
    "| Artefact | Expected (SHA256SUMS) | Expected (release-evidence.json) | Observed | Attestation | Result |",
    "|---|---|---|---|---|---|",
    ...r.artefacts.map((a) => `| ${a.name} | ${a.expected_sha256.sha256sums ?? "—"} | ${a.expected_sha256.release_evidence ?? "—"} | ${a.observed_sha256 ?? "—"} | ${a.attestation} | ${a.result} |`),
    "",
    ...r.artefacts.flatMap((a) => a.reasons.map((x) => `- ${a.name}: ${x}`)),
    "",
    "Controls: SDLC-PREV-003 (Software Artifact Provenance), SDLC-PREV-002 (Content Addressable IDs), OP-007 (Monitoring).",
    "Do not install this release until the served artefact matches the approved digest and its attestation verifies.",
  ];
  return lines.join("\n") + "\n";
}

export interface Options { repo: string; run: Run; now: () => string }

/** One verification pass over every published release with a tarball. Returns the evidence record. */
export function verifyAll(gh: Gh, opts: Options): Evidence {
  const releases = gh.releases().filter((r) => !r.draft && r.assets.some((a) => isTarball(a.name)));
  const results = releases.map((r) => verifyRelease(gh, r));
  const failed = results.filter((r) => r.result === "fail");

  const findings: Evidence["findings"] = [];
  if (failed.length > 0) {
    gh.ensureLabel();
    const open = gh.openFindings();
    for (const r of failed) {
      const title = findingTitle(r.tag);
      const body = findingBody(r, opts.run);
      const existing = open.find((i) => i.title === title);
      if (existing !== undefined) {
        gh.comment(existing.number, body);
        findings.push({ tag: r.tag, issue: existing.number, action: "commented" });
      } else {
        const number = gh.createIssue(title, body);
        open.push({ number, title });
        findings.push({ tag: r.tag, issue: number, action: "opened" });
      }
    }
  }

  const all = results.flatMap((r) => r.artefacts);
  const provenance: Result = all.every((a) => a.attestation === "pass") ? "pass" : "fail";
  const digests: Result = results.every((r) => r.reasons.length === 0)
    && all.every((a) => a.observed_sha256 !== null && a.observed_sha256 === a.expected_sha256.sha256sums && a.observed_sha256 === a.expected_sha256.release_evidence)
    ? "pass" : "fail";
  const result: Result = failed.length === 0 ? "pass" : "fail";
  return {
    schema: SCHEMA,
    event: "release.verified",
    recorded_at: opts.now(),
    repository: opts.repo,
    run: opts.run,
    result,
    releases: results,
    findings,
    controls: [
      { id: "SDLC-PREV-003", catalog: "FINOS SDLC Common Controls", name: "Software Artifact Provenance", result: provenance, evidence: "releases[].artefacts[].attestation" },
      { id: "SDLC-PREV-002", catalog: "FINOS SDLC Common Controls", name: "Content Addressable Identities", result: digests, evidence: "releases[].artefacts[].observed_sha256" },
      { id: "OP-007", name: "Monitoring", result, evidence: "findings" },
    ],
  };
}

/** The real Gh, backed by the `gh` CLI. */
export function ghCli(repo: string): Gh {
  const gh = (args: string[], input?: string): Buffer => {
    const r = spawnSync("gh", args, { input, maxBuffer: 512 * 1024 * 1024 });
    if (r.error !== undefined) throw r.error;
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (${r.status ?? "signal"}): ${r.stderr.toString("utf8")}`);
    return r.stdout;
  };
  return {
    releases: () => gh(["api", "--paginate", `repos/${repo}/releases`, "--jq",
      ".[] | {tag: .tag_name, url: .html_url, draft: .draft, assets: [.assets[] | {id, name}]}"])
      .toString("utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as ReleaseInfo),
    download: (asset) => gh(["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${asset.id}`]),
    attest: (name, bytes) => {
      const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
      try {
        const file = join(dir, name.replace(/[/\\]/g, "_"));
        writeFileSync(file, bytes);
        const r = spawnSync("gh", ["attestation", "verify", file, "--repo", repo], { encoding: "utf8" });
        const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").filter((l) => l.trim() !== "").slice(-3).join(" / ");
        return { ok: r.error === undefined && r.status === 0, detail: r.error?.message ?? detail };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    ensureLabel: () => {
      gh(["label", "create", FINDING_LABEL, "--repo", repo, "--force", "--color", "b60205",
        "--description", "Detective control finding (verify-release)"]);
    },
    openFindings: () => JSON.parse(gh(["issue", "list", "--repo", repo, "--state", "open", "--label", FINDING_LABEL,
      "--limit", "200", "--json", "number,title"]).toString("utf8")) as Issue[],
    createIssue: (title, body) => {
      const url = gh(["issue", "create", "--repo", repo, "--title", title, "--label", FINDING_LABEL, "--body-file", "-"], body).toString("utf8").trim();
      const n = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
      if (!Number.isInteger(n)) throw new Error(`gh issue create returned no issue URL: ${url}`);
      return n;
    },
    comment: (issue, body) => { gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], body); },
  };
}

function main(argv: string[]): number {
  const arg = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const env = process.env;
  const repo = arg("--repo") ?? env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  const out = arg("--out") ?? "verify-release-evidence.json";
  const run: Run = env.GITHUB_RUN_ID !== undefined
    ? { url: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`, attempt: env.GITHUB_RUN_ATTEMPT ?? "1" }
    : { url: "local run (no GITHUB_RUN_ID)", attempt: "1" };
  const gh = ghCli(repo);
  if (argv.includes("--dry-run")) {
    // Reads only: verify everything, but print the findings instead of writing issues.
    gh.ensureLabel = () => undefined;
    gh.openFindings = () => [];
    gh.createIssue = (title) => { console.log(`[dry-run] would open or comment: ${title}`); return 0; };
  }
  const evidence = verifyAll(gh, { repo, run, now: () => new Date().toISOString() });
  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  for (const r of evidence.releases) {
    console.log(`${r.result.toUpperCase()} ${r.tag}`);
    for (const x of [...r.reasons, ...r.artefacts.flatMap((a) => a.reasons.map((y) => `${a.name}: ${y}`))]) console.log(`  - ${x}`);
  }
  for (const f of evidence.findings) console.log(`finding ${f.action}: #${f.issue} (${f.tag})`);
  console.log(`verify-release: ${evidence.result} (${evidence.releases.length} release(s)); evidence in ${out}`);
  return evidence.result === "pass" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
