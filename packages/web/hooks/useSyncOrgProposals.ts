// Staffing proposals — store-fed (docs/architecture/org-staffing.md S4, S5).
// Two feeders into two collections: the workspace's proposal list (rows
// without changes) and, for the proposal the pane has open, its changes by
// row id. The page joins them with joinProposals and paints from the store.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { isMissingFunctionError } from "./useSyncOrgTree";

const api = _api as any;

const selectList = (payload: any) => payload?.proposals ?? [];
const selectChanges = (payload: any) => payload?.changes ?? [];

/** The active workspace's proposals, scoped like the org tree. */
export function useSyncOrgProposals(enabled = true): { ready: boolean; error?: Error; missing: boolean } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamArg = !enabled ? "skip" : !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const { ready, error } = useSyncCollection("orgProposals", api.orgProposals.list, teamArg, { select: selectList });
  return { ready, error, missing: isMissingFunctionError(error) };
}

/** One proposal's changes, by short id ("op-7") or row id; null skips. */
export function useSyncOrgProposalChanges(proposal: string | null): { ready: boolean; error?: Error } {
  return useSyncCollection("orgProposalChanges", api.orgProposals.get, proposal ? { proposal } : "skip", { select: selectChanges });
}
