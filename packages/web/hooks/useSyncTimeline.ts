// Timeline lanes (commits, pull requests) — store-fed delta overlays.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

export function useSyncCommits(args: { start_time?: number; end_time?: number; repository?: string; limit?: number } | "skip" = {}) {
  return useSyncCollection("commits", api.commits.getCommitsForTimeline, args);
}

export function useSyncPullRequests(args: { repository?: string; limit?: number } | "skip" = {}) {
  return useSyncCollection("pullRequests", api.pull_requests.getPRsForTimeline, args);
}

const commitSig = (c: any) => `${c.message}|${c.timestamp}|${c.pr_number ?? ""}|${c.conversation_id ?? ""}`;
const prSig = (p: any) => `${p.title}|${p.state}|${p.updated_at}|${p.merged_at ?? ""}|${p.linked_session_ids?.length ?? 0}`;
const byTimestampDesc = (a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0);
const byUpdatedDesc = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

export function useCommits(where?: (c: any) => boolean): any[] {
  return useCollectionRows<any>("commits", { where, sig: commitSig, sort: byTimestampDesc });
}

export function usePullRequests(where?: (p: any) => boolean): any[] {
  return useCollectionRows<any>("pullRequests", { where, sig: prSig, sort: byUpdatedDesc });
}

// One PR, fed into the same collection the timeline fills. The page reads the
// store, so a PR the timeline already cached paints before this answers.
export function useSyncPullRequest(args: { repository: string; number: number } | "skip") {
  return useSyncCollection("pullRequests", api.pull_requests.getPRByNumber, args, {
    select: (row: any) => (row ? [row] : []),
  });
}

// The PR page paints far more of a row than the timeline lane does, so it wakes
// on its own signature rather than widening the lane's.
const prDetailSig = (p: any) =>
  [
    p.title, p.state, p.draft, p.updated_at, p.merged_at ?? "", p.body,
    p.head_sha ?? "", p.mergeable_state ?? "", p.behind_by ?? "", p.review_decision ?? "",
    p.checks_state ?? "", (p.checks ?? []).length, p.unresolved_review_count ?? "",
    (p.requested_reviewers ?? []).join(","), (p.linked_session_ids ?? []).join(","),
    (p.task_ids ?? []).join(","), (p.files ?? []).length,
    p.shepherd_state ?? "", p.shepherd_enabled ?? "", p.shepherd_conversation_id ?? "",
    p.shepherd_last_wake_at ?? "", p.shepherd_wake_count ?? "",
  ].join("|");

export function usePullRequest(repository: string, number: number): any | undefined {
  const rows = useCollectionRows<any>("pullRequests", {
    where: (p) => p.repository === repository && p.number === number,
    sig: prDetailSig,
  });
  return rows[0];
}
