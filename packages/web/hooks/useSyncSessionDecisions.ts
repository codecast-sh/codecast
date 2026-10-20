import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type SessionDecisionItem } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

// sessionDecisions is the one home of every decision row the web holds: the
// viewer's queue (cast decide: pending questions and a short window of
// resolved ones, listForUser) and the team's open line decisions
// (listOpenForLines, while the Line page is open). Both send a row the same
// way (convex decisionRowsForViewer), each prunes only the rows it answers
// for, and `in_queue` says which rows are the viewer's own (inViewerQueue).

/** The queue feed answers for every row in the viewer's queue. */
const QUEUE_SYNC = { isDelta: true, pruneAbsentScope: (r: SessionDecisionItem) => r.in_queue !== false };

// useQueryNoThrow because the queue only enriches the inbox — the app must
// keep rendering if the function is missing (deploy gap) or errors.
export function useSyncSessionDecisions() {
  const { data: result } = useQueryNoThrow(api.sessionDecisions.listForUser, {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    syncTable("sessionDecisions", data, QUEUE_SYNC);
  }, [syncTable]));
}

/** Feeder: the open line decisions of these workspaces (team or personal keys), every one the viewer can read, whoever
 *  it was asked of. The feed answers for the rows it brought that are not in the viewer's queue. */
export function useSyncTeamLineDecisions(workspaces: ReadonlyArray<string>) {
  const key = [...workspaces].sort().join(",");
  const args = useMemo(() => (key ? { workspaces: key.split(",") } : "skip"), [key]);
  const opts = useMemo(() => {
    const read = new Set(key.split(","));
    return { syncOpts: { isDelta: true, pruneAbsentScope: (r: SessionDecisionItem) => r.in_queue === false && !!r.line_workspace && read.has(r.line_workspace) } };
  }, [key]);
  return useSyncCollection("sessionDecisions", api.sessionDecisions.listOpenForLines, args as any, opts);
}
