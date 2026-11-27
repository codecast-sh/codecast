// Feeder of `priorityRanks` (convex priorityRanks.mine): the rank, id and
// title of each of the viewer's active priorities in every workspace they
// hold, which every inbox card's priority chip names and the Priorities view
// sorts other workspaces' sessions by (store/priorityOrder). Fed whenever any
// workspace the viewer works in has priorities on (one subscription); mounted
// in the sync host's feeders (DashboardLayout HostFeeders).
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { prioritiesAnywhere } from "../store/priorityOrder";
import { useSyncCollection } from "./useSyncCollection";

export function useSyncPriorityRanks() {
  const on = useInboxStore(prioritiesAnywhere);
  return useSyncCollection("priorityRanks", (api as any).priorityRanks.mine, on ? {} : "skip");
}
