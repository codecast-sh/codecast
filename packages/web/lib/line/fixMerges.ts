// Fixes that landed outside the line's own record: a fix branch merged by hand
// through its pull request, or a commit on the default branch naming the task.
import type { HandMerge } from "./causeHistory";

/** A task row's landed commit (schema tasks.landed), as `fixMerges` reads it. */
export type LandedTask = { _id: string; landed?: { sha: string; at: number; url: string; branch: string } | null };

/** The pull request rows `fixMerges` reads (the store's pullRequests). */
export type FixPullRequest = { state?: string; merged_at?: number; head_ref?: string; base_ref?: string; task_ids?: string[]; repository?: string; number?: number };

/**
 * Problems whose fix branch (`codecast/line-<ref>`, the branch the line builds on) merged through a pull request linked
 * to them, or whose task a commit on the default branch names, keyed by task id: when, and the pull request. A person lands the run's branch this way when the line's merge
 * step is off, and the line's own record never hears of it (ct-58282, union-mobile#3859). Each problem's history reads it
 * as its merge (causeHistory handMerge), so every surface says merged and in production from the same record.
 */
export function fixMerges(prs: Iterable<FixPullRequest>, refOf: (taskId: string) => string | null | undefined, landed: Iterable<LandedTask> = []): Map<string, HandMerge> {
  const out = new Map<string, HandMerge>();
  for (const pr of prs) {
    if (pr.state !== "merged" || !pr.merged_at || !pr.head_ref?.startsWith("codecast/line-")) continue;
    for (const id of pr.task_ids ?? []) {
      if (`codecast/line-${refOf(id)}` !== pr.head_ref) continue;
      const prev = out.get(id);
      if (!prev || prev.at < pr.merged_at) out.set(id, { at: pr.merged_at, url: `https://github.com/${pr.repository}/pull/${pr.number}`, branch: pr.head_ref, into: pr.base_ref ?? null });
    }
  }
  // A commit naming the problem that landed on its default branch (tasks.landed): how most fixes reach a product's main.
  // A merged pull request of the fix branch says more (which branch, its page), so it wins.
  for (const t of landed) if (t.landed && !out.has(t._id)) out.set(t._id, { at: t.landed.at, url: t.landed.url, sha: t.landed.sha, into: t.landed.branch });
  return out;
}

/** fixMerges as a string a store selector can return, so a component re-renders only when one of them changes. */
export const fixMergesSig = (prs: Record<string, FixPullRequest> | undefined, refOf: (taskId: string) => string | null | undefined, landed: Iterable<LandedTask> = []): string =>
  JSON.stringify([...fixMerges(Object.values(prs ?? {}), refOf, landed)]);
