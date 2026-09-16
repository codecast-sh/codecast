import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

// The viewer's decision stacks (D5), open ones by default. A snapshot feed:
// listStacks is the complete visible set, and every stack verb (add, remove,
// reorder, policy) is a named mutation whose result echoes through it.
export function useSyncDecisionStacks(opts?: { includeDone?: boolean; skip?: boolean }) {
  // One argument set for every surface: listStacks is a snapshot feed, and
  // two feeders that disagree on include_done drop and restore each other's
  // done rows. Surfaces that want open stacks only filter the store rows.
  return useSyncCollection("decisionStacks", api.decisionStacks.listStacks, opts?.skip ? "skip" : { include_done: opts?.includeDone ?? true });
}
