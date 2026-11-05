// audit-query.ts — answers "Scenario D" questions about one change from recorded evidence alone (issue #42).
//
// Given a commit sha (full or a prefix of 7+ hex chars) or a release tag, it reports:
//   1. who / which agent made the change
//   2. who approved it, and whether that approver was an independent vendor
//   3. which checks passed at that head
//   4. which artefact (name + sha256) was released, and who approved the release
//   5. whether the release was re-verified since, and the result
// It reads ONLY files under `--evidence <dir>` (searched recursively). No network, no `gh`, no git.
//
// Usage:
//   node scripts/audit-query.ts <sha|tag> --evidence <dir> [--json]
// Exit codes: 0 evidence found; 1 no evidence for the query (explicit "no evidence" message);
//             2 usage error (bad flags, unreadable dir, ambiguous sha prefix).
//
// Evidence files recognised in <dir>. Files are classified by CONTENT, not by name:
//
//   A. release evidence — JSON object, schema "task-management.control-evidence/v1",
//      event "release.published" (written by .github/workflows/release.yml as release-evidence.json):
//        { artefact: { name, sha256, tag, commit }, recorded_at, triggered_by,
//          approvals: [{ login, state, comment }], checks: { <name>: "pass"|"fail" },
//          controls: [...], run: { url, attempt }, provenance: {...} }
//
//   B. verify-release evidence — JSON object, same schema, event "release.verified"
//      (written by scripts/verify-release.ts as verify-release-evidence.json):
//        { recorded_at, result: "pass"|"fail", error?, releases: [{ tag, result, artefacts, reasons }],
//          skipped: [{ tag, reason }], run: { url, attempt } }
//
//   C. control-audit JSONL — any `*.jsonl` file, as written by scripts/control-audit.ts (--out): one
//      `control.evaluated` record per line, one line per PR per control (plus repository controls):
//        { schema, event: "control.evaluated", recorded_at, repository, run,
//          subject: { kind: "pr"|"branch"|"commit", ref, pr?, sha? },   // sha = the PR head (kind "pr") or the commit
//          control: { id, catalog, version, check, name }, result: "pass"|"fail", reasons: [...], evidence: [...] }
//      The producer records verdicts, not identities: it does NOT record the merge sha, the author's or
//      reviewer's login or vendor, or per-check results. So this tool reports those as unavailable and
//      answers from the verdicts that ARE recorded (agent-vendor-trailer, independent-approval-at-head,
//      vendor-separation, required-checks-green). A line without `subject` and `control.check` is a
//      warning and is skipped; it never aborts the query.
//
// Independence rule: an approval is "independent" only when the control-audit `vendor-separation` verdict
// for that head is a recorded pass. A recorded fail is "NO"; no record is "no evidence", never assumed.
// A release is linked to a PR only when the release's commit equals the queried/recorded sha; the audit
// records carry no merge sha, so a tag does not reach back to its PR.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const SCHEMA = "task-management.control-evidence/v1";
const MIN_PREFIX = 7;

type Json = Record<string, unknown>;

export interface AuditRecord {
  kind: string;
  pr: number | null;
  sha: string;
  check: string;
  control_id: string;
  result: string;
  reasons: string[];
  evidence: string[];
  source: string;
  /** From the record's optional `actors` object (control-audit since #69); null on older records. */
  actors: RecordedActors | null;
}

export interface RecordedActors {
  author: string | null;
  author_vendor: string | null;
  reviewer: string | null;
  reviewer_vendor: string | null;
  merge_sha: string | null;
  merged_at: string | null;
  checks: Record<string, string>;
}

export interface ReleaseEvidence {
  source: string;
  recorded_at: string | null;
  tag: string | null;
  commit: string | null;
  artefact: { name: string; sha256: string } | null;
  approvers: string[];
  triggered_by: string | null;
  checks: Record<string, string>;
}

export interface VerifyEvidence {
  source: string;
  recorded_at: string | null;
  tag: string;
  result: string;
}

export interface Corpus {
  audit: AuditRecord[];
  releases: ReleaseEvidence[];
  verifications: VerifyEvidence[];
  warnings: string[];
  files: string[];
}

export interface Answer {
  query: string;
  found: boolean;
  resolved: { commit: string | null; tag: string | null };
  change: { pr: number | null; head_sha: string; merge_sha: string | null; merged_at: string | null; author: string | null; author_vendor: string | null; merged_via_pr: string | null; vendor_declared: string | null } | null;
  approval: { reviewer: string | null; reviewer_vendor: string | null; independent_approval_at_head: string | null; vendor_separation: string | null; independent: boolean | null; reasons: string[] } | null;
  checks: { head_sha: string; result: string | null; passed: string[]; conclusions: Record<string, string> | null; failure_reasons: string[]; controls: { id: string; check: string; result: string }[] } | null;
  release: {
    tag: string | null; commit: string | null; artefact: string | null; sha256: string | null;
    approved_by: string[]; triggered_by: string | null; recorded_at: string | null; checks: Record<string, string>;
  } | null;
  verification: { reverified: boolean; result: string | null; recorded_at: string | null; since_release: boolean | null; source: string | null } | null;
  warnings: string[];
  evidence_files: string[];
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function checksOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) out[k] = typeof val === "string" ? val : String(val);
  return out;
}

/**
 * Recursively list evidence files. A dangling link, unreadable entry, symlink cycle or a link whose
 * target resolves outside the evidence root is a warning, never an abort and never read: the answer
 * must come from evidence supplied inside --evidence only.
 */
function listFiles(dir: string, root: string, warnings: string[], seen: Set<string> = new Set(), realRoot: string = realpathSync(root)): string[] {
  const rel = (p: string): string => p.slice(root.length).replace(/^[/\\]+/, "") || ".";
  const real = realpathSync(dir);
  if (seen.has(real)) { warnings.push(`${rel(dir)}: directory already visited, symlink cycle or duplicate (skipped)`); return []; }
  seen.add(real);
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    let target: string;
    try { st = statSync(p); target = realpathSync(p); } catch { warnings.push(`${rel(p)}: unreadable or dangling link (skipped)`); continue; }
    if (target !== realRoot && !target.startsWith(realRoot + sep)) { warnings.push(`${rel(p)}: resolves outside the evidence directory (skipped)`); continue; }
    if (st.isDirectory()) out.push(...listFiles(p, root, warnings, seen, realRoot));
    else if (st.isFile() && /\.jsonl?$/i.test(name)) out.push(p);
  }
  return out;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
function actorsOf(v: unknown): RecordedActors | null {
  if (!isObj(v)) return null;
  return { author: strOrNull(v.author), author_vendor: strOrNull(v.author_vendor), reviewer: strOrNull(v.reviewer), reviewer_vendor: strOrNull(v.reviewer_vendor),
    merge_sha: strOrNull(v.merge_sha), merged_at: strOrNull(v.merged_at), checks: checksOf(v.checks) };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A record is "recognised" when it is a well-formed control record; one with no sha (branch protection) is kept out of the sha index. */
function toAudit(o: Json, source: string): AuditRecord | "no-sha" | null {
  if (o.schema !== SCHEMA || o.event !== "control.evaluated") return null;
  const subject = o.subject;
  const c = o.control;
  if (!isObj(subject) || !isObj(c)) return null;
  const sha = str(subject.sha);
  const check = str(c.check);
  const result = str(o.result);
  if (check === null || result === null) return null;
  if (sha === null) return "no-sha";
  return {
    kind: str(subject.kind) ?? "",
    pr: typeof subject.pr === "number" ? subject.pr : null,
    sha: sha.toLowerCase(),
    check,
    control_id: str(c.id) ?? "",
    result,
    reasons: strs(o.reasons),
    evidence: strs(o.evidence),
    actors: actorsOf(o.actors),
    source,
  };
}

/** Read every evidence file under `dir`. Unparseable or unrecognised files become warnings, never throw. */
export function loadEvidence(dir: string): Corpus {
  const corpus: Corpus = { audit: [], releases: [], verifications: [], warnings: [], files: [] };
  for (const file of listFiles(dir, dir, corpus.warnings)) {
    const rel = file.slice(dir.length).replace(/^[/\\]+/, "");
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { corpus.warnings.push(`${rel}: unreadable (skipped)`); continue; }
    if (/\.jsonl$/i.test(file)) {
      let used = 0;
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.trim() === "") return;
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { rec = undefined; }
        const a = isObj(rec) ? toAudit(rec, rel) : null;
        if (a === null) corpus.warnings.push(`${rel}:${i + 1}: not a control-audit record (skipped)`);
        else { used++; if (a !== "no-sha") corpus.audit.push(a); }
      });
      if (used > 0) corpus.files.push(rel);
      continue;
    }
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { corpus.warnings.push(`${rel}: not valid JSON (skipped)`); continue; }
    if (!isObj(doc) || doc.schema !== SCHEMA) continue;
    if (doc.event === "release.published") {
      const a = isObj(doc.artefact) ? doc.artefact : {};
      const name = str(a.name);
      const digest = str(a.sha256);
      corpus.releases.push({
        source: rel,
        recorded_at: str(doc.recorded_at),
        tag: str(a.tag),
        commit: str(a.commit)?.toLowerCase() ?? null,
        artefact: name !== null && digest !== null ? { name, sha256: digest.toLowerCase() } : null,
        approvers: Array.isArray(doc.approvals)
          ? doc.approvals.flatMap((x) => (isObj(x) && x.state === "approved" && str(x.login) !== null ? [str(x.login) ?? ""] : []))
          : [],
        triggered_by: str(doc.triggered_by),
        checks: checksOf(doc.checks),
      });
      corpus.files.push(rel);
    } else if (doc.event === "release.verified") {
      for (const r of Array.isArray(doc.releases) ? doc.releases : []) {
        if (isObj(r) && str(r.tag) !== null) {
          corpus.verifications.push({ source: rel, recorded_at: str(doc.recorded_at), tag: str(r.tag) ?? "", result: str(r.result) ?? "unknown" });
        }
      }
      corpus.files.push(rel);
    }
  }
  return corpus;
}

const isHex = (s: string): boolean => /^[0-9a-f]+$/.test(s);
const matches = (sha: string | null, q: string): boolean => sha !== null && sha.startsWith(q);

/** Answer the five questions for `query` (a sha or prefix, or a tag). Pure: no I/O. */
export function answer(corpus: Corpus, query: string): Answer | { ambiguous: string[] } {
  const q = query.toLowerCase();
  const shaLike = q.length >= MIN_PREFIX && isHex(q);

  const byTag = corpus.releases.filter((r) => r.tag === query);
  let commit: string | null = byTag[0]?.commit ?? null;
  if (shaLike) {
    const full = new Set<string>();
    const mergeShas = new Set<string>();
    for (const a of corpus.audit) {
      if (matches(a.sha, q)) full.add(a.sha);
      // A merge commit recorded by control-audit resolves to its PR head, so one change is not two answers.
      else if (a.actors?.merge_sha != null && matches(a.actors.merge_sha, q)) { full.add(a.sha); mergeShas.add(a.actors.merge_sha); }
    }
    for (const r of corpus.releases) if (r.commit !== null && matches(r.commit, q) && !mergeShas.has(r.commit)) full.add(r.commit);
    if (full.size > 1) return { ambiguous: [...full].sort() };
    commit = [...full][0] ?? q;
  }

  // Records at the queried commit, plus records of the PR that was merged as that commit (control-audit `actors.merge_sha`).
  const records = commit === null ? [] : corpus.audit.filter((a) => a.sha === commit || a.actors?.merge_sha === commit);
  const linked = new Set<string>(commit === null ? [] : [commit]);
  for (const r of records) if (r.actors?.merge_sha != null) linked.add(r.actors.merge_sha);
  const releases = byTag.length > 0 ? byTag : corpus.releases.filter((r) => r.commit !== null && linked.has(r.commit));
  const rel = releases[0] ?? null;
  const warnings = [...corpus.warnings];
  // Several release records for one tag are only harmless when they agree; otherwise say so rather than pick one silently.
  if (rel !== null && releases.some((r) => r.artefact?.sha256 !== rel.artefact?.sha256 || r.commit !== rel.commit)) {
    warnings.push(`conflicting release evidence for ${rel.tag ?? "this commit"}: ${releases.map((r) => `${r.source} (${r.artefact?.sha256 ?? "no digest"}, commit ${r.commit ?? "?"})`).join("; ")}; showing the first`);
  }
  const tag =rel?.tag ?? (corpus.verifications.some((v) => v.tag === query) ? query : null);

  const prRecords = records.filter((r) => r.kind === "pr");
  const first = prRecords[0] ?? null;
  // Several records for one control at one head are only a pass when all pass; otherwise show the worst one.
  const verdictOf = (check: string): AuditRecord | null => {
    const all = prRecords.filter((r) => r.check === check);
    return all.find((r) => r.result === "fail") ?? all.find((r) => r.result !== "pass") ?? all[0] ?? null;
  };
  const separation = verdictOf("vendor-separation");
  const approval = verdictOf("independent-approval-at-head");
  const green = verdictOf("required-checks-green");
  // Identity facts are recorded on every PR record at a head; take them from the first record that carries them.
  const actors = prRecords.find((r) => r.actors !== null)?.actors ?? null;

  const verifs = corpus.verifications.filter((v) => tag !== null && v.tag === tag)
    .sort((a, b) => (a.recorded_at ?? "").localeCompare(b.recorded_at ?? ""));
  const latest = verifs[verifs.length - 1] ?? null;

  const found = records.length > 0 || rel !== null || latest !== null;
  return {
    query,
    found,
    resolved: { commit: records.length > 0 ? commit : rel?.commit ?? null, tag },
    change: first === null ? null : {
      pr: first.pr, head_sha: first.sha, merge_sha: actors?.merge_sha ?? null, merged_at: actors?.merged_at ?? null,
      author: actors?.author ?? null, author_vendor: actors?.author_vendor ?? null,
      merged_via_pr: verdictOf("merged-via-pr")?.result ?? null,
      vendor_declared: verdictOf("agent-vendor-trailer")?.result ?? null,
    },
    approval: first === null ? null : {
      reviewer: actors?.reviewer ?? null, reviewer_vendor: actors?.reviewer_vendor ?? null,
      independent_approval_at_head: approval?.result ?? null,
      vendor_separation: separation?.result ?? null,
      // Independent only when BOTH a valid approval at the head and vendor separation are recorded passes.
      independent: approval?.result === "fail" || separation?.result === "fail" ? false
        : approval?.result === "pass" && separation?.result === "pass" ? true : null,
      reasons: [...(approval?.result === "pass" ? [] : approval?.reasons ?? []), ...(separation?.result === "pass" ? [] : separation?.reasons ?? [])],
    },
    checks: records.length === 0 ? null : {
      head_sha: first?.sha ?? commit ?? "",
      result: green?.result ?? null,
      passed: green?.result === "pass" ? green.evidence.flatMap((e) => (e.startsWith("check ") ? [e.slice(6)] : [])).sort() : [],
      conclusions: actors !== null && Object.keys(actors.checks).length > 0 ? actors.checks : null,
      failure_reasons: green !== null && green.result !== "pass" ? green.reasons : [],
      controls: records.map((r) => ({ id: r.control_id, check: r.check, result: r.result })),
    },
    release: rel === null ? null : {
      tag: rel.tag, commit: rel.commit, artefact: rel.artefact?.name ?? null, sha256: rel.artefact?.sha256 ?? null,
      approved_by: rel.approvers, triggered_by: rel.triggered_by, recorded_at: rel.recorded_at, checks: rel.checks,
    },
    verification: rel === null && latest === null ? null : {
      reverified: latest !== null,
      result: latest?.result ?? null,
      recorded_at: latest?.recorded_at ?? null,
      since_release: latest === null || rel === null || latest.recorded_at === null || rel.recorded_at === null
        ? null : latest.recorded_at >= rel.recorded_at,
      source: latest?.source ?? null,
    },
    warnings,
    evidence_files: corpus.files,
  };
}

const NO = "no evidence";

export function render(a: Answer): string {
  const L: string[] = [];
  L.push(`audit-query: ${a.query}${a.resolved.commit !== null ? `  (commit ${a.resolved.commit})` : ""}${a.resolved.tag !== null ? `  (tag ${a.resolved.tag})` : ""}`);
  L.push("");
  L.push("1. Who / which agent made the change?");
  L.push(a.change === null ? `   ${NO} (no control-audit record for a pull request at this commit)`
    : `   PR ${a.change.pr === null ? "?" : `#${a.change.pr}`}  head ${a.change.head_sha}  merged via PR: ${a.change.merged_via_pr ?? NO}\n   author: ${a.change.author ?? "not recorded"}; agent vendor: ${a.change.author_vendor ?? "not recorded"} (agent-vendor-trailer: ${a.change.vendor_declared ?? NO})\n   merge sha: ${a.change.merge_sha ?? "not recorded"}; merged at: ${a.change.merged_at ?? "not recorded"}`);
  L.push("2. Who approved, and was it an independent vendor?");
  if (a.approval === null) L.push(`   ${NO}`);
  else {
    const ind = a.approval.independent === null ? NO : a.approval.independent ? "yes" : "NO";
    L.push(`   approver login: ${a.approval.reviewer ?? "not recorded"}; reviewer vendor: ${a.approval.reviewer_vendor ?? "not recorded"}; independent approval at head: ${a.approval.independent_approval_at_head ?? NO}; independent vendor (vendor-separation): ${ind}`);
    for (const r of a.approval.reasons) L.push(`   - ${r}`);
  }
  L.push("3. Which checks passed at that head?");
  if (a.checks === null) L.push(`   ${NO}`);
  else if (a.checks.result === null) L.push(`   head ${a.checks.head_sha}\n   ${NO} (no required-checks-green record)`);
  else {
    L.push(`   head ${a.checks.head_sha}\n   required-checks-green: ${a.checks.result}\n   passed: ${a.checks.passed.join(", ") || "none recorded"}`);
    for (const r of a.checks.failure_reasons) L.push(`   - ${r}`);
  }
  L.push("4. What was released, and who approved the release?");
  L.push(a.release === null ? `   ${NO} (no release evidence for this commit/tag)`
    : `   ${a.release.artefact ?? "unknown artefact"} sha256 ${a.release.sha256 ?? "unknown"}  tag ${a.release.tag ?? "?"}  commit ${a.release.commit ?? "?"}\n   approved by: ${a.release.approved_by.join(", ") || "no approver recorded"}  (triggered by ${a.release.triggered_by ?? "unknown"})`);
  L.push("5. Re-verified since?");
  if (a.verification === null) L.push(`   ${NO}`);
  else if (!a.verification.reverified) L.push(`   NO — ${NO} of any re-verification for this release`);
  else L.push(`   yes — ${(a.verification.result ?? "unknown").toUpperCase()} at ${a.verification.recorded_at ?? "unknown time"}${a.verification.since_release === false ? " (older than the release record)" : ""}`);
  for (const w of a.warnings) L.push(`warning: ${w}`);
  return L.join("\n") + "\n";
}

export interface Io { out: (s: string) => void; err: (s: string) => void }

export function main(argv: string[], io: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }): number {
  const json = argv.includes("--json");
  const ei = argv.indexOf("--evidence");
  const dirArg = ei >= 0 ? argv[ei + 1] : undefined;
  const positional = argv.filter((x, i) => !x.startsWith("--") && i !== ei + 1);
  const query = positional[0];
  if (query === undefined || positional.length > 1 || dirArg === undefined || dirArg.startsWith("--")) {
    io.err("usage: audit-query.ts <sha|tag> --evidence <dir> [--json]\n");
    return 2;
  }
  let corpus: Corpus;
  try { corpus = loadEvidence(resolve(dirArg)); } catch (e) {
    io.err(`audit-query: cannot read evidence dir ${dirArg}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const a = answer(corpus, query);
  if ("ambiguous" in a) {
    io.err(`audit-query: ${query} is ambiguous; matches ${a.ambiguous.join(", ")}\n`);
    return 2;
  }
  if (!a.found) {
    const msg = `no evidence for ${query} in ${dirArg}`;
    if (json) io.out(JSON.stringify({ query, found: false, error: msg, warnings: a.warnings, evidence_files: a.evidence_files }, null, 2) + "\n");
    else io.out(`audit-query: ${msg.replace(/^no evidence/, "NO EVIDENCE")}\n`);
    return 1;
  }
  io.out(json ? JSON.stringify(a, null, 2) + "\n" : render(a));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
