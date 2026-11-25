// Feeds one person's long profile (orgPeople.person) into orgPersonDetails.
// The page reads the row from the store (useOrgPersonDetail); the short fields
// and the reporting lines it also returns stay on the org tree's person row,
// their one home, so the row keeps only what the tree lacks.
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { orgPersonDetailId, personDetailRow, type OrgPersonDetail } from "../store/orgProfile";

export function useSyncOrgPerson(teamId: string | undefined, userId: string | undefined) {
  const ok = !!teamId && !!userId && isConvexId(teamId) && isConvexId(userId);
  const select = useCallback((d: any) => personDetailRow(teamId ?? "", d), [teamId]);
  return useSyncCollection(
    "orgPersonDetails",
    api.orgPeople.person,
    ok ? ({ team_id: teamId, user_id: userId } as any) : "skip",
    { select },
  );
}

export function useOrgPersonDetail(teamId: string | undefined, userId: string | undefined): OrgPersonDetail | undefined {
  return useInboxStore((s) => (teamId && userId ? s.orgPersonDetails[orgPersonDetailId(teamId, userId)] : undefined));
}
