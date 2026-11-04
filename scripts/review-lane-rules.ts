// review-lane-rules.ts — the review lane's decision rules (issue #20; the runner is #21).
//
// Pure functions only: no child processes, no network, no git. The single filesystem
// read is halted()'s check for the Gibson kill-switch file. Modelled on The Gibson's
// D-018 reviewer controller and its rules (the-gibson memory/DECISIONS.md,
// playbooks/reviewer.md, docs/review-protocol.md, scripts/second-opinion.sh #290).

import { existsSync } from "node:fs";
import { join } from "node:path";

export type Vendor = "claude" | "codex" | "grok" | "devin";
const VENDORS: readonly string[] = ["claude", "codex", "grok", "devin"];

export interface CheckRun { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null }
export interface Review { id?: number; user: { login: string } | null; state: string; commit_id: string; submitted_at?: string | null }
export type Caps = Record<string, number | string>;
export type Decision =
  | { action: "review"; author: Vendor; reviewer: Vendor }
  | { action: "skip"; reason: string };

/**
 * The single Agent-Vendor declared across a PR's commits, or why there isn't one. Every commit
 * must declare one; any line whose key is Agent-Vendor must carry exactly one known vendor
 * (a malformed line could otherwise hide a second vendor); all commits must agree.
 */
export function authorVendor(messages: string[]): { vendor: Vendor } | { reason: string } {
  if (messages.length === 0) return { reason: "no commits" };
  const found = new Set<string>();
  for (const [i, message] of messages.entries()) {
    const lines = [...message.matchAll(/^[ \t]*agent-vendor[ \t]*:(.*)$/gim)].map((m) => (m[1] ?? "").trim());
    if (lines.length === 0) return { reason: `commit ${i + 1} has no Agent-Vendor trailer` };
    for (const value of lines) {
      const v = value.toLowerCase();
      if (!/^\S+$/.test(v)) return { reason: `commit ${i + 1} has a malformed Agent-Vendor line: '${value}'` };
      if (!VENDORS.includes(v)) return { reason: `unknown vendor: ${v}` };
      found.add(v);
    }
  }
  const vendors = [...found].sort();
  if (vendors.length > 1) return { reason: `mixed vendors: ${vendors.join(",")}` };
  const only = vendors[0];
  return only === undefined ? { reason: "no Agent-Vendor trailer on any commit" } : { vendor: only as Vendor };
}

/** Law 5: the reviewer is always a different vendor from the author. */
export function pickReviewer(author: Vendor): Vendor {
  return author === "codex" ? "claude" : "codex";
}

/**
 * Every required check's latest run at this head completed with success. "Latest" is by
 * started_at, not by ID; if any run lacks a start time, or the newest start time is shared
 * by runs that disagree, recency cannot be established and the check fails closed.
 */
export function requiredChecksGreen(runs: CheckRun[], required: string[]): { ok: true } | { ok: false; reason: string } {
  if (required.length === 0) return { ok: false, reason: "no required checks configured" };
  for (const name of required) {
    const named = runs.filter((r) => r.name === name);
    if (named.length === 0) return { ok: false, reason: `required check '${name}' has not run` };
    const times = named.map((r) => Date.parse(r.started_at ?? ""));
    if (times.some((t) => Number.isNaN(t))) return { ok: false, reason: `required check '${name}' has a run with no start time (recency unknown)` };
    const newest = Math.max(...times);
    const tied = named.filter((_, i) => times[i] === newest);
    const latest = tied[0];
    if (latest === undefined) return { ok: false, reason: `required check '${name}' has not run` };
    if (tied.some((r) => r.status !== latest.status || r.conclusion !== latest.conclusion)) {
      return { ok: false, reason: `required check '${name}' has conflicting runs at the same start time (recency unknown)` };
    }
    if (latest.status !== "completed") return { ok: false, reason: `required check '${name}' is ${latest.status}` };
    if (latest.conclusion !== "success") return { ok: false, reason: `required check '${name}' concluded ${latest.conclusion ?? "none"}` };
  }
  return { ok: true };
}

/** A verdict by the reviewer identity already exists at this exact head. */
export function reviewedAtHead(reviews: Review[], login: string, head: string): boolean {
  return reviews.some((r) => r.user?.login === login && r.commit_id === head
    && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"));
}

/**
 * Tier from the PR's tier-* label; with none, the Gibson caps file's default. Undefined when
 * ambiguous (two different tiers) or invalid (a tier-* label other than a/b/c): fail closed.
 */
export function tierOf(labels: string[], caps: Caps): string | undefined {
  const tiers = new Set<string>();
  for (const label of labels) {
    const m = /^tier-(.*)$/i.exec(label.trim());
    if (m === null) continue;
    const t = (m[1] ?? "").toUpperCase();
    if (!/^[ABC]$/.test(t)) return undefined;
    tiers.add(t);
  }
  if (tiers.size > 1) return undefined;
  const [only] = [...tiers];
  if (only !== undefined) return only;
  const fallback = caps.default;
  return typeof fallback === "string" && /^[ABC]$/.test(fallback) ? fallback : undefined;
}

/** The tier's OWN cap from the-gibson config/review-round-caps.json (no borrowing another tier's), or undefined if missing or not a non-negative integer. */
export function capOf(tier: string, caps: Caps): number | undefined {
  if (!/^[ABC]$/.test(tier)) return undefined;
  const raw = caps[tier];
  const cap = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(cap) && cap >= 0 ? cap : undefined;
}

/**
 * Per-tier cap on review rounds. A round is a CHANGES_REQUESTED verdict by the reviewer, and a
 * DISMISSED one also counts: GitHub turns a dismissed review into DISMISSED, so dismissing
 * rejections must not reset the cap. An unknown cap counts as reached (fail closed).
 */
export function roundCapReached(reviews: Review[], login: string, tier: string, caps: Caps): boolean {
  const cap = capOf(tier, caps);
  if (cap === undefined) return true;
  const rounds = reviews.filter((r) => r.user?.login === login && (r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")).length;
  return rounds >= cap;
}

export interface PrFacts {
  number: number; state: string; isDraft: boolean; baseRefName: string; head: string; labels: string[];
  runs: CheckRun[]; reviews: Review[]; commitMessages: string[];
}

/** The posted review, read back: by the reviewer identity, at the exact head, in the expected state, after this attempt began. */
export function verifyPublished(reviews: Review[], login: string, head: string, event: "approve" | "request-changes", since: string):
  { ok: true; id: number } | { ok: false; reason: string } {
  const want = event === "approve" ? "APPROVED" : "CHANGES_REQUESTED";
  const start = Date.parse(since);
  if (Number.isNaN(start)) return { ok: false, reason: "publication uncertain: attempt start time unknown" };
  const atHead = reviews.filter((r) => r.user?.login === login && r.commit_id === head);
  // any same-reviewer, same-head review whose time is unknown makes "exactly one new" unprovable
  if (atHead.some((r) => Number.isNaN(Date.parse(r.submitted_at ?? "")))) {
    return { ok: false, reason: `publication uncertain: a review by ${login} at ${head.slice(0, 7)} has no valid submission time` };
  }
  const mine = atHead.filter((r) => Date.parse(r.submitted_at ?? "") > start); // strictly after the attempt began
  if (mine.length !== 1) return { ok: false, reason: `publication uncertain: ${mine.length} new reviews by ${login} at ${head.slice(0, 7)}` };
  const only = mine[0];
  if (only?.state !== want || only.id === undefined) return { ok: false, reason: `publication mismatch: state ${only?.state ?? "none"}, expected ${want}` };
  return { ok: true, id: only.id };
}

/**
 * A captain's bounded exception to the round cap (Gibson docs/review-protocol.md): it applies only to the
 * exact "<pr>@<40-hex head>" named in REVIEW_LANE_CAP_EXCEPTION, so a later push is capped again.
 */
export function capExceptionApplies(value: string | undefined, pr: number, head: string): boolean {
  return value !== undefined && /^\d+@[0-9a-f]{40}$/.test(value) && value === `${pr}@${head}`;
}

/** Fail closed: review only when every condition is positively established. */
export function decide(pr: PrFacts, opts: { login: string; required: string[]; caps: Caps; attempted: boolean; capException?: string }): Decision {
  if (!Number.isInteger(pr.number) || pr.number <= 0) return { action: "skip", reason: "invalid PR number" };
  if (!/^[0-9a-f]{40}$/.test(pr.head)) return { action: "skip", reason: "invalid head SHA" };
  if (opts.login.trim() === "") return { action: "skip", reason: "reviewer login not configured" };
  if (pr.state !== "OPEN") return { action: "skip", reason: `PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { action: "skip", reason: "draft" };
  if (pr.baseRefName !== "main") return { action: "skip", reason: `base is ${pr.baseRefName}, not main` };
  if (reviewedAtHead(pr.reviews, opts.login, pr.head)) return { action: "skip", reason: "already reviewed at this head" };
  if (opts.attempted) return { action: "skip", reason: "already attempted at this head (one attempt per head)" };
  const tier = tierOf(pr.labels, opts.caps);
  if (tier === undefined) return { action: "skip", reason: "tier unknown (conflicting or invalid tier labels, or no valid default)" };
  // a broken caps config is never lifted, not even by a captain's exception
  if (capOf(tier, opts.caps) === undefined) return { action: "skip", reason: `Tier ${tier} round cap unknown (invalid review-round-caps config)` };
  // The exception is checked here, against this PR's number and head: a caller cannot widen it.
  if (roundCapReached(pr.reviews, opts.login, tier, opts.caps) && !capExceptionApplies(opts.capException, pr.number, pr.head)) {
    return { action: "skip", reason: `Tier ${tier} round cap reached — captain decision required` };
  }
  const checks = requiredChecksGreen(pr.runs, opts.required);
  if (!checks.ok) return { action: "skip", reason: checks.reason };
  const author = authorVendor(pr.commitMessages);
  if ("reason" in author) return { action: "skip", reason: author.reason };
  return { action: "review", author: author.vendor, reviewer: pickReviewer(author.vendor) };
}

/**
 * Environment for every gh read AND for the reviewing AI: no reviewer token in any form.
 * Removes the reviewer-token variables by name, and every variable whose value contains
 * a given secret (e.g. the reviewer token placed in GH_TOKEN), whatever it is called.
 */
export function readEnv(env: NodeJS.ProcessEnv, secrets: string[] = []): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.GH_REVIEWER_TOKEN;
  delete copy.GIBSON_REVIEWER_TOKEN;
  delete copy.GIBSON_FORMAL_REVIEW; // second-opinion.sh must not publish; the lane publishes after
  const live = secrets.filter((x) => x !== "");
  for (const [k, v] of Object.entries(copy)) {
    if (v !== undefined && live.some((x) => v.includes(x))) delete copy[k];
  }
  return copy;
}

/** Environment for formal-review.sh only: the one process that holds the reviewer token. */
export function publisherEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  if (token.trim() === "") throw new Error("reviewer token is empty");
  return { ...readEnv(env, [token]), GH_REVIEWER_TOKEN: token };
}

/**
 * The Gibson's slot-authority rule (second-opinion.sh #290), applied only to its own status
 * lines, exactly "second-opinion.sh: slot:<name> state:<state>" (second-opinion.sh:479), so
 * text elsewhere in the output cannot pose as a verdict: any request-changes → request-changes;
 * every slot approve → approve; anything else (no slots, no-verdict, error) → no formal review.
 */
export function slotEvent(output: string): "approve" | "request-changes" | undefined {
  const states = [...output.matchAll(/^second-opinion\.sh: slot:\S+ state:(\S+)$/gm)].map((m) => m[1]);
  if (states.includes("request-changes")) return "request-changes";
  if (states.length > 0 && states.every((st) => st === "approve")) return "approve";
  return undefined;
}

/** The Gibson kill switch: a gibson/HALT file, or GIBSON_HALT=1. */
export function halted(dir = ".", env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(dir, "gibson", "HALT")) || env.GIBSON_HALT === "1";
}
