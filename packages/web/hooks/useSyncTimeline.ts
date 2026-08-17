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
