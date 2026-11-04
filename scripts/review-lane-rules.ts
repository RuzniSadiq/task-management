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

/** The single Agent-Vendor declared across a PR's commits, or why there isn't one. */
export function authorVendor(messages: string[]): { vendor: Vendor } | { reason: string } {
  const found = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(/^Agent-Vendor:[ \t]*(\S+)[ \t]*$/gim)) {
      if (match[1] !== undefined) found.add(match[1].toLowerCase());
    }
  }
  const vendors = [...found].sort();
  const only = vendors[0];
  if (only === undefined) return { reason: "no Agent-Vendor trailer on any commit" };
  if (vendors.length > 1) return { reason: `mixed vendors: ${vendors.join(",")}` };
  return VENDORS.includes(only) ? { vendor: only as Vendor } : { reason: `unknown vendor: ${only}` };
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

/** Tier from the PR's tier-a/b/c label; the Gibson caps file supplies the default. */
export function tierOf(labels: string[], caps: Caps): string {
  for (const label of labels) {
    const m = /^tier-([abc])$/i.exec(label);
    if (m?.[1] !== undefined) return m[1].toUpperCase();
  }
  return String(caps.default ?? "A");
}

/** the-gibson config/review-round-caps.json: per-tier cap on CHANGES_REQUESTED rounds. */
export function roundCapReached(reviews: Review[], login: string, tier: string, caps: Caps): boolean {
  const cap = Number(caps[tier] ?? caps[String(caps.default ?? "A")] ?? 1);
  const rounds = reviews.filter((r) => r.user?.login === login && r.state === "CHANGES_REQUESTED").length;
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
  const mine = reviews.filter((r) => r.user?.login === login && r.commit_id === head && Date.parse(r.submitted_at ?? "") >= Date.parse(since));
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
  if (pr.state !== "OPEN") return { action: "skip", reason: `PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { action: "skip", reason: "draft" };
  if (pr.baseRefName !== "main") return { action: "skip", reason: `base is ${pr.baseRefName}, not main` };
  if (reviewedAtHead(pr.reviews, opts.login, pr.head)) return { action: "skip", reason: "already reviewed at this head" };
  if (opts.attempted) return { action: "skip", reason: "already attempted at this head (one attempt per head)" };
  const tier = tierOf(pr.labels, opts.caps);
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
  return { ...readEnv(env, [token]), GH_REVIEWER_TOKEN: token };
}

/**
 * The Gibson's slot-authority rule (second-opinion.sh #290), applied to its
 * "slot:<name> state:<state>" lines: any request-changes → request-changes; every slot
 * approve → approve; anything else (no slots, no-verdict, error) → no formal review.
 */
export function slotEvent(output: string): "approve" | "request-changes" | undefined {
  const states = [...output.matchAll(/slot:\S+ state:(\S+)/g)].map((m) => m[1]);
  if (states.includes("request-changes")) return "request-changes";
  if (states.length > 0 && states.every((st) => st === "approve")) return "approve";
  return undefined;
}

/** The Gibson kill switch: a gibson/HALT file, or GIBSON_HALT=1. */
export function halted(dir = ".", env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(dir, "gibson", "HALT")) || env.GIBSON_HALT === "1";
}
