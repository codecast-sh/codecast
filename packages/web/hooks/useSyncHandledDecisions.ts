import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

// "Handled without you" (D2): decisions among the viewer's people set that a
// role answered under a grant in the last 14 days. Snapshot feed.
export function useSyncHandledDecisions(skip = false) {
  return useSyncCollection("handledDecisions", api.sessionDecisions.listHandledByRoles, skip ? "skip" : {});
}
