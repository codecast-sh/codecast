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
import { initiativeSig, tasksByProject } from "../lib/initiatives";
import { useCollectionRows } from "./useCollectionRows";
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

type RollupTask = { _id: string; status?: string; project_id?: string | null; plan_id?: string | null };
/** A rollup reads where a task sits and whether it is done, nothing else: a
 *  retitle or a comment on any task repaints no progress bar. */
const rollupSig = (t: RollupTask) => `${t.status ?? ""}|${t.project_id ?? ""}|${t.plan_id ?? ""}`;

const planHomeSig = (p: { project_id?: string | null }) => p.project_id ?? "";

/** The workspace's tasks bucketed by project, for every progress bar on a page. */
export function useTasksByProject(): Map<string, RollupTask[]> {
  const tasks = useWorkspaceCollection<RollupTask>("tasks", rollupSig);
  const plans = useWorkspaceCollection<{ _id: string; project_id?: string | null }>("plans", planHomeSig);
  return useMemo(() => tasksByProject(tasks, plans), [tasks, plans]);
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
