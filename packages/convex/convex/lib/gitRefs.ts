// Git references, folded.
//
// Two jobs live here, both pure enough to unit test:
//   1. Reading codecast object ids out of free git text — a commit message, a
//      PR title or body, a branch name — and resolving them to rows.
//   2. Folding many small GitHub facts (check runs, a review decision, a
//      merge state) into the one word a card can show.
//
// Everything a webhook processor or the PR shepherd needs to answer "what does
// this git activity mean" is here, so the processors stay thin.

import { Id } from "../_generated/dataModel";
import { bareEntityIdRegex, inferEntityTypeFromShortId } from "@codecast/shared/entities";

type Db = { db: any };

/**
 * Every task short id in a piece of git text, lowercased and deduped, in the
 * order it appears.
 *
 * The scan comes from the shared mention vocabulary, so a branch
 * (`ct-123-fix-auth`, `feature/ct-123`), a commit message and a PR body are all
 * read the same way, and a newly registered short id prefix needs no change
 * here. Only task ids survive the filter: a PR body that mentions pl-88 links
 * its plan through the task, not directly.
 */
export function extractTaskShortIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.match(bareEntityIdRegex()) ?? []) {
    const id = match.toLowerCase();
    if (inferEntityTypeFromShortId(id) !== "task") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type TaskLinks = {
  task_ids: Id<"tasks">[];
  plan_ids: Id<"plans">[];
  project_ids: Id<"projects">[];
};

/**
 * Short ids to real rows, plus the plans and projects those tasks belong to.
 *
 * A miss is silent: git text names ids from other workspaces and from before
 * the task was deleted, and a push must never fail because a commit message
 * quoted a stale id.
 */
export async function resolveTaskLinks(ctx: Db, shortIds: string[]): Promise<TaskLinks> {
  const task_ids: Id<"tasks">[] = [];
  const planIds = new Set<string>();
  const projectIds = new Set<string>();

  for (const shortId of shortIds) {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", shortId))
      .first();
    if (!task) continue;
    task_ids.push(task._id);
    if (task.plan_id) planIds.add(String(task.plan_id));
    if (task.project_id) projectIds.add(String(task.project_id));
  }

  return {
    task_ids,
    plan_ids: [...planIds] as Id<"plans">[],
    project_ids: [...projectIds] as Id<"projects">[],
  };
}

/** Read the task links straight out of git text. */
export async function resolveTaskLinksFromText(ctx: Db, ...texts: (string | null | undefined)[]): Promise<TaskLinks> {
  return resolveTaskLinks(ctx, extractTaskShortIds(texts.filter(Boolean).join("\n")));
}

// ── Folding GitHub state ──

export type CheckEntry = {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
  updated_at: number;
  external_id?: string;
};

/** Conclusions GitHub reports that do not mean the check failed. */
export const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * One word for a head commit's whole check suite:
 * "none" (nothing ran) | "pending" | "failure" | "success".
 *
 * A single failure decides the answer no matter what else is still running,
 * because that is the fact the shepherd must act on first.
 */
export function foldChecksState(checks: CheckEntry[] | undefined | null): string {
  if (!checks || checks.length === 0) return "none";
  let pending = false;
  for (const check of checks) {
    if (check.status !== "completed") { pending = true; continue; }
    if (!check.conclusion) { pending = true; continue; }
    if (!PASSING_CONCLUSIONS.has(check.conclusion)) return "failure";
  }
  return pending ? "pending" : "success";
}

export type ShepherdPrState = {
  state?: string;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  behind_by?: number;
  checks_state?: string;
  review_decision?: string;
};

/**
 * The PR's status in one word, ordered by what the shepherd must handle first.
 *
 * Merged and closed end the story. Then come the states only the author can
 * clear (conflicts, a stale base, red CI, requested changes), then the states
 * that mean waiting (CI still running, nobody has reviewed), and finally the
 * good news. A card and a wake prompt both read this one value, so they can
 * never disagree about where the PR stands.
 */
export function foldShepherdState(pr: ShepherdPrState): string {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.mergeable === false || pr.mergeable_state === "dirty") return "conflicts";
  if ((pr.behind_by ?? 0) > 0 || pr.mergeable_state === "behind") return "behind";
  if (pr.checks_state === "failure") return "ci_red";
  if (pr.review_decision === "changes_requested") return "changes_requested";
  if (pr.checks_state === "pending") return "ci_pending";
  if (!pr.review_decision || pr.review_decision === "none" || pr.review_decision === "review_required") {
    return "review_pending";
  }
  if (pr.review_decision === "approved") return "approved";
  return "ready";
}

/**
 * One spelling for a repository.
 *
 * GitHub treats an owner and a repository name as case insensitive, so the same
 * repository reaches us as "Codecast-SH/Codecast" from a person typing it and
 * "codecast-sh/codecast" from a webhook. Every index we look it up by is a byte
 * comparison, so both the value stored and the value searched for go through
 * here and one spelling wins.
 */
export function normalizeRepository<T extends string | undefined | null>(repository: T): T {
  return (typeof repository === "string" ? repository.toLowerCase() : repository) as T;
}

export function prUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

export function commitUrl(repository: string, sha: string): string {
  return `https://github.com/${repository}/commit/${sha}`;
}

export function shortSha(sha: string | undefined | null): string {
  return (sha ?? "").slice(0, 7);
}
