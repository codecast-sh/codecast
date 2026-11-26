// Feeder of `priorityRanks` (convex priorityRanks.mine): the rank of each of
// the viewer's active priorities in every workspace they hold, which the
// inbox's Priorities view labels and sorts other workspaces' sessions by
// (store/priorityOrder). Fed while that view is up; mounted in the sync
// host's feeders (DashboardLayout HostFeeders) and the phone's inbox.
import { api } from "@codecast/convex/convex/_generated/api";
import { resolveInboxViewMode, useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

export function useSyncPriorityRanks() {
  const on = useInboxStore((s) => resolveInboxViewMode(s) === "priorities");
  return useSyncCollection("priorityRanks", (api as any).priorityRanks.mine, on ? {} : "skip");
}
