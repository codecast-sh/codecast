// Initiatives: feeders + readers
// (docs/architecture/initiatives-projects-role-page.md I1).
//
// `initiatives` is one workspace wide snapshot query, mounted once by
// HostFeeders: there are few of them and every surface that names one (the
// list, a project's line, the task board's axis, an `in-N` pill) reads the
// same rows. `initiativeUpdates` is fed for the one initiative on screen and
// read by its `initiative_id`, never by enumeration.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { isConvexId } from "../lib/entityLinks";
import { initiativeSig, type BoardTask } from "../lib/initiatives";
import { useCollectionRows } from "./useCollectionRows";
import { syncMetaKey } from "./reconcileCrawl";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

export function useSyncInitiatives() {
  const workspaceArgs = useWorkspaceArgs();
  useSyncCollection("initiatives", api.initiatives.webList, workspaceArgs === "skip" ? "skip" : workspaceStamp(workspaceArgs));
}

/** Every initiative of the active workspace, waking on the fields a surface paints. */
export function useInitiatives(): InitiativeRow[] {
  return useWorkspaceCollection<InitiativeRow>("initiatives", initiativeSig);
}

/** One initiative by whatever names it: its id, its `in-N`, or the key of a
 *  stub the server has not numbered yet. */
export function useInitiative(ref: string): { initiative: InitiativeRow | null; all: InitiativeRow[] } {
  const all = useInitiatives();
  const initiative = useMemo(() => {
    const short = ref.toLowerCase();
    return all.find((r) => r._id === ref || r.short_id === short || r.client_key === ref) ?? null;
  }, [all, ref]);
  return { initiative, all };
}

/** A progress bar reads where a task sits, whether it is done and whether
 *  the board would show it, nothing else: a retitle or a comment on any task
 *  repaints no bar. */
const boardSig = (t: BoardTask) => `${t.status ?? ""}|${t.project_id ?? ""}|${t.source ?? ""}|${t.promoted ? 1 : 0}|${t.assignee ?? ""}|${t.triage_status ?? ""}`;

/** The workspace's tasks, for every progress bar on a page (lib/initiatives initiativeProgress). */
export function useBoardTasks(): BoardTask[] {
  return useWorkspaceCollection<BoardTask>("tasks", boardSig);
}

/** Whether the task store holds the whole workspace. On a cold cache it holds
 *  the newest rows until the crawl ends (hooks/useSyncTasks), so a count read
 *  from it is partial until `syncMeta` says the backfill completed; the same
 *  key the feeder writes. A bar shows the count as partial until then. */
export function useTasksBackfilled(): boolean {
  const wsArgs = useWorkspaceArgs();
  const key = syncMetaKey("tasks", wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs));
  return useInboxStore((s) => !!s.syncMeta?.[key]?.backfilledAt);
}

/** A stub has no server row to ask about yet. */
export function useSyncInitiativeUpdates(initiativeId: string | null) {
  return useSyncCollection("initiativeUpdates", api.initiatives.webUpdates, initiativeId && isConvexId(initiativeId) ? { initiative_id: initiativeId } : "skip");
}

const updateSig = (u: InitiativeUpdateRow) => `${u.health}|${u.at}|${u.body.length}`;
const newestFirst = (a: InitiativeUpdateRow, b: InitiativeUpdateRow) => b.at - a.at;

export function useInitiativeUpdates(initiativeId: string | null): InitiativeUpdateRow[] {
  const where = useMemo(() => (u: InitiativeUpdateRow) => u.initiative_id === initiativeId, [initiativeId]);
  return useCollectionRows<InitiativeUpdateRow>("initiativeUpdates", { where, sig: updateSig, sort: newestFirst });
}
