// Git events — store-fed delta overlays, one feeder per window.
//
// Every query here is a window onto the same collection: the team's newest
// events, one conversation's, one PR's. They all land in the `externalEvents` store
// key, so a surface reads the store and never the query (the registered-feeds
// guard enforces that). Mount the team feeder once, on the sync host; mount a
// scoped feeder wherever that scope is open.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { ExternalEventRecord } from "../lib/externalEvents";

// `api` is a proxy, so naming a function that prod has not deployed yet still
// produces a reference; the call then fails and useQueryNoThrow (inside
// useSyncCollection) returns it as an error instead of unmounting the surface.
// That is what lets this ship before the backend half is deployed.
const api = _api as any;

const KEY = "externalEvents";

export function useSyncTeamExternalEvents(args: { team_id?: string; limit?: number } | "skip" = { limit: 200 }) {
  return useSyncCollection(KEY, api.externalEvents.listForTeam, args);
}

export function useSyncConversationExternalEvents(conversationId: string | undefined) {
  return useSyncCollection(
    KEY,
    api.externalEvents.listForConversation,
    conversationId ? { conversation_id: conversationId } : "skip",
  );
}

export function useSyncTaskExternalEvents(taskId: string | undefined) {
  return useSyncCollection(KEY, api.externalEvents.listForTask, taskId ? { task_id: taskId } : "skip");
}

export function useSyncPlanExternalEvents(planId: string | undefined) {
  return useSyncCollection(KEY, api.externalEvents.listForPlan, planId ? { plan_id: planId } : "skip");
}

export function useSyncProjectExternalEvents(projectId: string | undefined) {
  return useSyncCollection(KEY, api.externalEvents.listForProject, projectId ? { project_id: projectId } : "skip");
}

export function useSyncPRExternalEvents(prId: string | undefined) {
  return useSyncCollection(KEY, api.externalEvents.listForPR, prId ? { pr_id: prId } : "skip");
}

export function useSyncRepositoryExternalEvents(
  args: { repository: string; branch?: string; limit?: number } | "skip",
) {
  return useSyncCollection(KEY, api.externalEvents.listForRepository, args);
}

// The fields a row component paints. A change to any of them re-renders the
// reader; a change to anything else on the row does not.
const externalEventSig = (e: ExternalEventRecord) =>
  `${e.kind}|${e.title}|${e.created_at}|${e.meta?.conclusion ?? ""}|${e.meta?.status ?? ""}|${e.meta?.review_state ?? ""}|${e.meta?.shepherd_state ?? ""}`;

const byCreatedDesc = (a: ExternalEventRecord, b: ExternalEventRecord) => (b.created_at ?? 0) - (a.created_at ?? 0);
const byCreatedAsc = (a: ExternalEventRecord, b: ExternalEventRecord) => (a.created_at ?? 0) - (b.created_at ?? 0);

export const externalEventsNewestFirst = byCreatedDesc;
export const externalEventsOldestFirst = byCreatedAsc;

export function useExternalEvents(
  where?: (row: ExternalEventRecord) => boolean,
  sort: (a: ExternalEventRecord, b: ExternalEventRecord) => number = byCreatedDesc,
): ExternalEventRecord[] {
  return useCollectionRows<ExternalEventRecord>(KEY, { where, sig: externalEventSig, sort });
}
