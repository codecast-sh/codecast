// Staffing proposals — store-fed (docs/architecture/org-staffing.md S4, S5).
// Two feeders into two collections: the workspace's proposal list (rows
// without changes) and, for the proposal the pane has open, the proposal
// itself plus its changes by row id. The page joins them with joinProposals
// and paints from the store.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isMissingFunctionError } from "./useSyncOrgTree";

const api = _api as any;

const selectList = (payload: any) => payload?.proposals ?? [];

/** The active workspace's proposals, scoped like the org tree. */
export function useSyncOrgProposals(enabled = true): { ready: boolean; error?: Error; missing: boolean } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamArg = !enabled ? "skip" : !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const { ready, error } = useSyncCollection("orgProposals", api.orgProposals.list, teamArg, { select: selectList });
  return { ready, error, missing: isMissingFunctionError(error) };
}

/**
 * One proposal by short id ("op-7") or row id, whatever workspace it lives
 * in: the payload fans out into the `orgProposals` row (so a link into
 * another workspace resolves to a row the page can name) and the
 * `orgProposalChanges` rows. `missing` is a server answer of null: no such
 * proposal, or one the viewer cannot read.
 */
export function useSyncOrgProposal(proposal: string | null): { ready: boolean; missing: boolean; error?: Error } {
  const { data, error } = useQueryNoThrow(api.orgProposals.get, proposal ? { proposal } : "skip");
  const syncTable = useInboxStore((s) => s.syncTable);
  useConvexSync(
    data,
    useCallback((payload: any) => {
      if (!payload) return;
      const { changes, ...row } = payload;
      syncTable("orgProposals", [row]);
      syncTable("orgProposalChanges", changes ?? []);
    }, [syncTable]),
  );
  const ready = !!proposal && data !== undefined;
  return { ready, missing: ready && data === null, error };
}
