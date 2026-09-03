// Git events — store-fed delta overlays, one feeder per window.
//
// Every query here is a window onto the same collection: the team's newest
// events, one conversation's, one PR's. They all land in the `gitEvents` store
// key, so a surface reads the store and never the query (the registered-feeds
// guard enforces that). Mount the team feeder once, on the sync host; mount a
// scoped feeder wherever that scope is open.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { GitEventRow } from "../lib/externalEvents";

// `api` is a proxy, so naming a function that prod has not deployed yet still
// produces a reference; the call then fails and useQueryNoThrow (inside
// useSyncCollection) returns it as an error instead of unmounting the surface.
// That is what lets this ship before the backend half is deployed.
const api = _api as any;

const KEY = "gitEvents";

export function useSyncTeamGitEvents(args: { team_id?: string; limit?: number } | "skip" = { limit: 200 }) {
  return useSyncCollection(KEY, api.gitEvents.listForTeam, args);
}

export function useSyncConversationGitEvents(conversationId: string | undefined) {
  return useSyncCollection(
    KEY,
    api.gitEvents.listForConversation,
    conversationId ? { conversation_id: conversationId } : "skip",
  );
}

export function useSyncTaskGitEvents(taskId: string | undefined) {
  return useSyncCollection(KEY, api.gitEvents.listForTask, taskId ? { task_id: taskId } : "skip");
}

export function useSyncPlanGitEvents(planId: string | undefined) {
  return useSyncCollection(KEY, api.gitEvents.listForPlan, planId ? { plan_id: planId } : "skip");
}

export function useSyncProjectGitEvents(projectId: string | undefined) {
  return useSyncCollection(KEY, api.gitEvents.listForProject, projectId ? { project_id: projectId } : "skip");
}

export function useSyncPRGitEvents(prId: string | undefined) {
  return useSyncCollection(KEY, api.gitEvents.listForPR, prId ? { pr_id: prId } : "skip");
}

export function useSyncRepositoryGitEvents(
  args: { repository: string; branch?: string; limit?: number } | "skip",
) {
  return useSyncCollection(KEY, api.gitEvents.listForRepository, args);
}

// The fields a row component paints. A change to any of them re-renders the
// reader; a change to anything else on the row does not.
const gitEventSig = (e: GitEventRow) =>
  `${e.kind}|${e.title}|${e.created_at}|${e.meta?.conclusion ?? ""}|${e.meta?.status ?? ""}|${e.meta?.review_state ?? ""}|${e.meta?.shepherd_state ?? ""}`;

const byCreatedDesc = (a: GitEventRow, b: GitEventRow) => (b.created_at ?? 0) - (a.created_at ?? 0);
const byCreatedAsc = (a: GitEventRow, b: GitEventRow) => (a.created_at ?? 0) - (b.created_at ?? 0);

export const gitEventsNewestFirst = byCreatedDesc;
export const gitEventsOldestFirst = byCreatedAsc;

export function useGitEvents(
  where?: (row: GitEventRow) => boolean,
  sort: (a: GitEventRow, b: GitEventRow) => number = byCreatedDesc,
): GitEventRow[] {
  return useCollectionRows<GitEventRow>(KEY, { where, sig: gitEventSig, sort });
}
