// verify-release.ts — detective control for released artefacts (issue #40, Scenario C).
//
// release.yml is the preventive side: it gates, approves, attests and fingerprints each release.
// This script is the detective side. It runs on a schedule and after release events, and checks
// that what every published GitHub release serves still matches what was approved:
//   1. each tarball's sha256, recomputed from the downloaded bytes, equals its SHA256SUMS line
//   2. it also equals artefact.sha256 in the release's release-evidence.json
//   3. `gh attestation verify <tarball> --repo <repo>` succeeds (sigstore build provenance)
// Every published release with any asset is checked. A release may serve exactly three assets: the
// tarball named in its release-evidence.json, SHA256SUMS and release-evidence.json. Any other asset
// (a second tarball, a .tar.gz, a .zip) is hashed, recorded and fails the release.
// Any failure exits non-zero and opens one `control-finding` issue per release, or comments on the
// one already open for that release, so repeat runs never duplicate it. The evidence file is always
// written: a failure to list releases or to write a finding is recorded in it, never thrown away.
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
/** The only workflow whose attestation is accepted (path in the repo, per `gh attestation verify --signer-workflow`). */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

export interface Asset { id: number; name: string }
export interface ReleaseInfo { tag: string; url: string; draft: boolean; assets: Asset[] }
export interface Issue { number: number; title: string }

/** Every GitHub call the control makes. Methods throw on a gh failure. */
export interface Gh {
  releases(): ReleaseInfo[];
  download(asset: Asset): Buffer;
  /**
   * Run `gh attestation verify` on these exact bytes, saved under `name`. The attestation must come
   * from release.yml running on `refs/tags/<tag>`: any other workflow or ref (replay, minted) fails.
   */
  attest(name: string, bytes: Buffer, tag: string): { ok: boolean; detail: string };
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

export type Finding =
  | { tag: string; issue: number; action: "opened" | "commented" }
  | { tag: string; issue: null; action: "error"; error: string };

export interface Evidence {
  schema: typeof SCHEMA;
  event: "release.verified";
  recorded_at: string;
  repository: string;
  run: Run;
  result: Result;
  /** Set when the run could not list releases; `releases` is then empty and the result is fail. */
  error?: string;
  releases: ReleaseResult[];
  /** Releases not verified, and why (drafts; releases that serve no asset). */
  skipped: { tag: string; reason: string }[];
  findings: Finding[];
  controls: { id: string; catalog?: string; version?: string; name: string; result: Result; evidence: string }[];
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The two records release.yml publishes next to the artefact; every other asset is an artefact. */
const isRecord = (name: string): boolean => name === SUMS_ASSET || name === EVIDENCE_ASSET;
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
export function parseEvidence(text: string): { name: string; sha256: string; tag: string | null } | string {
  let rec: unknown;
  try { rec = JSON.parse(text); } catch { return `${EVIDENCE_ASSET} is not valid JSON`; }
  const artefact = (rec as { artefact?: { name?: unknown; sha256?: unknown; tag?: unknown } } | null)?.artefact;
  if (typeof artefact?.name !== "string" || typeof artefact.sha256 !== "string" || !HEX64.test(artefact.sha256.toLowerCase())) {
    return `${EVIDENCE_ASSET} has no artefact.name/artefact.sha256`;
  }
  return { name: artefact.name, sha256: artefact.sha256.toLowerCase(), tag: typeof artefact.tag === "string" ? artefact.tag : null };
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

  // The record must name this release's tag, or a record copied from another release would pass.
  if (typeof evidence !== "string" && evidence.tag !== rel.tag) {
    reasons.push(`${EVIDENCE_ASSET} records tag ${evidence.tag ?? "none"}, but this release is ${rel.tag}`);
  }

  // Every non-record asset is served to users, so every one is hashed and checked, whatever its name.
  const served = rel.assets.filter((a) => !isRecord(a.name));
  if (served.length === 0) reasons.push("release serves no artefact besides its records");
  if (typeof evidence !== "string" && !served.some((a) => a.name === evidence.name)) {
    reasons.push(`released artefact ${evidence.name} named in ${EVIDENCE_ASSET} is missing from the release`);
  }

  const artefacts = served.map((asset): ArtefactResult => {
    const why: string[] = [];
    const fromSums = sums?.get(asset.name) ?? null;
    if (sums !== undefined && fromSums === null) why.push(`${SUMS_ASSET} has no line for ${asset.name}`);
    let fromEvidence: string | null = null;
    if (typeof evidence !== "string") {
      if (evidence.name === asset.name) fromEvidence = evidence.sha256;
      else why.push(`unexpected asset: ${asset.name} is not the artefact recorded in ${EVIDENCE_ASSET} (${evidence.name})`);
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
      try { outcome = gh.attest(asset.name, bytes, rel.tag); } catch (e) { outcome = { ok: false, detail: errText(e) }; }
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

/**
 * Open or comment on one finding per failed release. Never throws: a GitHub failure (5xx, rate
 * limit, issues disabled) is recorded as an `error` finding so the verification results survive.
 */
function writeFindings(gh: Gh, failed: ReleaseResult[], run: Run): Finding[] {
  let open: Issue[];
  try {
    gh.ensureLabel();
    open = gh.openFindings();
  } catch (e) {
    const error = `could not read open findings: ${errText(e)}`;
    return failed.map((r) => ({ tag: r.tag, issue: null, action: "error", error }));
  }
  return failed.map((r): Finding => {
    const title = findingTitle(r.tag);
    const body = findingBody(r, run);
    const existing = open.find((i) => i.title === title);
    try {
      if (existing !== undefined) {
        gh.comment(existing.number, body);
        return { tag: r.tag, issue: existing.number, action: "commented" };
      }
      const number = gh.createIssue(title, body);
      open.push({ number, title });
      return { tag: r.tag, issue: number, action: "opened" };
    } catch (e) {
      return { tag: r.tag, issue: null, action: "error", error: `could not ${existing === undefined ? "open" : "comment on"} the finding: ${errText(e)}` };
    }
  });
}

/** One verification pass over every published release. Never throws; returns the evidence record. */
export function verifyAll(gh: Gh, opts: Options): Evidence {
  let listed: ReleaseInfo[] | undefined;
  let error: string | undefined;
  try { listed = gh.releases(); } catch (e) { error = `could not list releases: ${errText(e)}`; }

  const skipped: Evidence["skipped"] = [];
  const toVerify = (listed ?? []).filter((r) => {
    if (r.draft) skipped.push({ tag: r.tag, reason: "draft (not published)" });
    else if (r.assets.length === 0) skipped.push({ tag: r.tag, reason: "serves no assets" });
    else return true;
    return false;
  });
  // Verify everything first; writing findings comes after, so its failures cannot lose these results.
  const results = toVerify.map((r) => verifyRelease(gh, r));
  const failed = results.filter((r) => r.result === "fail");
  const findings = failed.length > 0 ? writeFindings(gh, failed, opts.run) : [];

  const all = results.flatMap((r) => r.artefacts);
  const ok = error === undefined;
  const provenance: Result = ok && all.every((a) => a.attestation === "pass") ? "pass" : "fail";
  const digests: Result = ok && results.every((r) => r.reasons.length === 0)
    && all.every((a) => a.observed_sha256 !== null && a.observed_sha256 === a.expected_sha256.sha256sums && a.observed_sha256 === a.expected_sha256.release_evidence)
    ? "pass" : "fail";
  const result: Result = ok && failed.length === 0 ? "pass" : "fail";
  return {
    schema: SCHEMA,
    event: "release.verified",
    recorded_at: opts.now(),
    repository: opts.repo,
    run: opts.run,
    result,
    ...(error === undefined ? {} : { error }),
    releases: results,
    skipped,
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
    attest: (name, bytes, tag) => {
      const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
      try {
        const file = join(dir, name.replace(/[/\\]/g, "_"));
        writeFileSync(file, bytes);
        const r = spawnSync("gh", ["attestation", "verify", file, "--repo", repo,
          "--signer-workflow", `${repo}/${RELEASE_WORKFLOW}`, "--source-ref", `refs/tags/${tag}`, "--deny-self-hosted-runners"], { encoding: "utf8" });
        const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").filter((l) => l.trim() !== "").slice(-3).join(" / ");
        return { ok: r.error === undefined && r.status === 0, detail: r.error?.message ?? detail };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    ensureLabel: () => {
      gh(["label", "create", FINDING_LABEL, "--repo", repo, "--force", "--color", "b60205",
        "--description", "Detective control finding (verify-release)"]);
    },
    // Paginated (slurped) so a finding beyond the first page is still found and never duplicated.
    openFindings: () => (JSON.parse(gh(["api", "--paginate", "--slurp",
      `repos/${repo}/issues?state=open&labels=${FINDING_LABEL}&per_page=100`]).toString("utf8")) as Issue[][]).flat()
      .map((i) => ({ number: i.number, title: i.title })),
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
    gh.comment = (issue) => { console.log(`[dry-run] would comment on #${issue}`); };
  }
  const evidence = verifyAll(gh, { repo, run, now: () => new Date().toISOString() });
  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  if (evidence.error !== undefined) console.log(`ERROR ${evidence.error}`);
  for (const r of evidence.releases) {
    console.log(`${r.result.toUpperCase()} ${r.tag}`);
    for (const x of [...r.reasons, ...r.artefacts.flatMap((a) => a.reasons.map((y) => `${a.name}: ${y}`))]) console.log(`  - ${x}`);
    for (const a of r.artefacts) console.log(`  ${a.name} sha256 ${a.observed_sha256 ?? "not downloaded"}`);
  }
  for (const s of evidence.skipped) console.log(`SKIP ${s.tag}: ${s.reason}`);
  for (const f of evidence.findings) {
    console.log(f.action === "error" ? `finding error (${f.tag}): ${f.error}` : `finding ${f.action}: #${f.issue} (${f.tag})`);
  }
  console.log(`verify-release: ${evidence.result} (${evidence.releases.length} release(s)); evidence in ${out}`);
  return evidence.result === "pass" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
