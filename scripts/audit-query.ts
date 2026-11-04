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
//   C. control-audit JSONL — any `*.jsonl` file; one JSON object per line, one line per PR per control
//      (produced by issue #41). Record shape (this header is the contract #41 must match):
//        {
//          "pr": 49,                               // number: the pull request
//          "head_sha": "<40 hex>",                 // string: PR head the checks and approval were bound to
//          "merge_sha": "<40 hex>" | null,         // string|null: resulting commit on the default branch
//          "author_vendor": "claude",              // string: vendor/agent that built the change
//          "reviewer": "ruzni-reviewer",           // string|null: identity that approved
//          "reviewer_vendor": "codex",             // string|null: vendor of the reviewing model
//          "checks": { "gate": "pass", ... },      // object name -> "pass"|"fail" (anything else counts as not passed)
//          "control": { "id": "SDLC-PREV-007", "catalog": "FINOS SDLC Common Controls", "result": "pass"|"fail" }
//        }
//      Extra fields are ignored. Blank lines are skipped; a line that is not a JSON object is reported
//      as a warning and skipped (it never aborts the query).
//
// Independence rule: an approval is "independent" only when both vendors are known (non-empty) and differ,
// compared case-insensitively. Unknown vendor is reported as not independent, never assumed independent.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const SCHEMA = "task-management.control-evidence/v1";
const MIN_PREFIX = 7;

type Json = Record<string, unknown>;

export interface AuditRecord {
  pr: number | null;
  head_sha: string;
  merge_sha: string | null;
  author_vendor: string | null;
  reviewer: string | null;
  reviewer_vendor: string | null;
  checks: Record<string, string>;
  control: { id: string; catalog: string | null; result: string } | null;
  source: string;
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
  change: { pr: number | null; head_sha: string; merge_sha: string | null; author_vendor: string | null } | null;
  approval: { reviewer: string | null; reviewer_vendor: string | null; independent: boolean } | null;
  checks: { head_sha: string; passed: string[]; failed: string[]; controls: { id: string; result: string }[] } | null;
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

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (st.isFile() && /\.jsonl?$/i.test(name)) out.push(p);
  }
  return out;
}

function toAudit(o: Json, source: string): AuditRecord | null {
  const head = str(o.head_sha);
  if (head === null) return null;
  const c = o.control;
  return {
    pr: typeof o.pr === "number" ? o.pr : null,
    head_sha: head.toLowerCase(),
    merge_sha: str(o.merge_sha)?.toLowerCase() ?? null,
    author_vendor: str(o.author_vendor),
    reviewer: str(o.reviewer),
    reviewer_vendor: str(o.reviewer_vendor),
    checks: checksOf(o.checks),
    control: isObj(c) && str(c.id) !== null ? { id: str(c.id) ?? "", catalog: str(c.catalog), result: str(c.result) ?? "unknown" } : null,
    source,
  };
}

/** Read every evidence file under `dir`. Unparseable or unrecognised files become warnings, never throw. */
export function loadEvidence(dir: string): Corpus {
  const corpus: Corpus = { audit: [], releases: [], verifications: [], warnings: [], files: [] };
  for (const file of listFiles(dir)) {
    const rel = file.slice(dir.length).replace(/^[/\\]+/, "");
    const text = readFileSync(file, "utf8");
    if (/\.jsonl$/i.test(file)) {
      let used = 0;
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.trim() === "") return;
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { rec = undefined; }
        const a = isObj(rec) ? toAudit(rec, rel) : null;
        if (a === null) corpus.warnings.push(`${rel}:${i + 1}: not a control-audit record (skipped)`);
        else { corpus.audit.push(a); used++; }
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
const vendorsIndependent = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() !== b.toLowerCase();

/** Answer the five questions for `query` (a sha or prefix, or a tag). Pure: no I/O. */
export function answer(corpus: Corpus, query: string): Answer | { ambiguous: string[] } {
  const q = query.toLowerCase();
  const shaLike = q.length >= MIN_PREFIX && isHex(q);

  const byTag = corpus.releases.filter((r) => r.tag === query);
  let commit: string | null = byTag[0]?.commit ?? null;
  if (shaLike) {
    const full = new Set<string>();
    for (const a of corpus.audit) for (const s of [a.head_sha, a.merge_sha]) if (s !== null && matches(s, q)) full.add(s);
    for (const r of corpus.releases) if (r.commit !== null && matches(r.commit, q)) full.add(r.commit);
    if (full.size > 1) return { ambiguous: [...full].sort() };
    commit = [...full][0] ?? q;
  }

  const records = commit === null ? [] : corpus.audit.filter((a) => a.head_sha === commit || a.merge_sha === commit);
  // A release records the commit it was cut from, usually the merge commit, so link through the audit record.
  const linked = new Set<string>(commit === null ? [] : [commit]);
  for (const r of records) { linked.add(r.head_sha); if (r.merge_sha !== null) linked.add(r.merge_sha); }
  const releases = byTag.length > 0 ? byTag : corpus.releases.filter((r) => r.commit !== null && linked.has(r.commit));
  const rel = releases[0] ?? null;
  const tag = rel?.tag ?? (corpus.verifications.some((v) => v.tag === query) ? query : null);

  const first = records[0] ?? null;
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const r of records) for (const [k, v] of Object.entries(r.checks)) (v === "pass" ? passed : failed).add(k);
  for (const k of failed) passed.delete(k);

  const verifs = corpus.verifications.filter((v) => tag !== null && v.tag === tag)
    .sort((a, b) => (a.recorded_at ?? "").localeCompare(b.recorded_at ?? ""));
  const latest = verifs[verifs.length - 1] ?? null;

  const found = first !== null || rel !== null || latest !== null;
  return {
    query,
    found,
    resolved: { commit: first !== null ? commit : rel?.commit ?? null, tag },
    change: first === null ? null : { pr: first.pr, head_sha: first.head_sha, merge_sha: first.merge_sha, author_vendor: first.author_vendor },
    approval: first === null ? null : {
      reviewer: first.reviewer,
      reviewer_vendor: first.reviewer_vendor,
      independent: vendorsIndependent(first.author_vendor, first.reviewer_vendor),
    },
    checks: first === null ? null : {
      head_sha: first.head_sha,
      passed: [...passed].sort(),
      failed: [...failed].sort(),
      controls: records.flatMap((r) => (r.control === null ? [] : [{ id: r.control.id, result: r.control.result }])),
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
    warnings: corpus.warnings,
    evidence_files: corpus.files,
  };
}

const NO = "no evidence";

export function render(a: Answer): string {
  const L: string[] = [];
  L.push(`audit-query: ${a.query}${a.resolved.commit !== null ? `  (commit ${a.resolved.commit})` : ""}${a.resolved.tag !== null ? `  (tag ${a.resolved.tag})` : ""}`);
  L.push("");
  L.push("1. Who / which agent made the change?");
  L.push(a.change === null ? `   ${NO} (no control-audit record for this commit)`
    : `   ${a.change.author_vendor ?? "unknown vendor"}  PR ${a.change.pr === null ? "?" : `#${a.change.pr}`}  head ${a.change.head_sha}  merge ${a.change.merge_sha ?? "none recorded"}`);
  L.push("2. Who approved, and was it an independent vendor?");
  L.push(a.approval === null ? `   ${NO}`
    : `   ${a.approval.reviewer ?? "no approver recorded"} (${a.approval.reviewer_vendor ?? "unknown vendor"}) — independent of author: ${a.approval.independent ? "yes" : "NO"}`);
  L.push("3. Which checks passed at that head?");
  L.push(a.checks === null ? `   ${NO}`
    : `   head ${a.checks.head_sha}\n   passed: ${a.checks.passed.join(", ") || "none"}\n   failed: ${a.checks.failed.join(", ") || "none"}`);
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
