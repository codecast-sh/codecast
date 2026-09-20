// The org record — store-fed (docs/architecture/org-staffing.md S21). Two
// feeders into two collections, the same pattern as the staffing proposals
// (useSyncOrgProposals): the workspace's entries, one per gesture, and the
// rows of an entry a person has unfolded. The History surfaces paint from the
// store; these hooks only fill it.
//
// The log is append only, so neither feeder prunes: the one field that moves
// on a row already written is `undone_by`, and the delta merge carries it.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isMissingFunctionError } from "./useSyncOrgTree";
import type { OrgUndoPreview } from "@codecast/shared/contracts/orgChange";

const api = _api as any;

/** null = the server refused the caller (see useSyncOrgProposals.selectList):
 *  not an authoritative answer, so the push is skipped. */
export const selectEntries = (payload: any): any[] | undefined => (payload && Array.isArray(payload.entries) ? payload.entries : undefined);

/** The active workspace's entries, newest first; `role` (a role's id or short
 *  id) keeps the entries that touched that role. `missing` is a server that
 *  does not have the record yet, which the surface says in words. */
export function useSyncOrgLog(opts: { enabled?: boolean; role?: string | null } = {}): { ready: boolean; error?: Error; missing: boolean } {
  const { enabled = true, role } = opts;
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const scoped = role ? { role } : {};
  const args = !enabled ? "skip" : !activeTeamId ? scoped : isConvexId(activeTeamId) ? { team_id: activeTeamId, ...scoped } : "skip";
  const { ready, error } = useSyncCollection("orgLog", api.orgChanges.list, args, { select: selectEntries });
  return { ready, error, missing: isMissingFunctionError(error) };
}

/** One entry's rows, in apply order, while its fold is open. The entry rides
 *  along so a fold opened from a link paints its own header too. */
export function useSyncOrgLogEntry(batch: string | null): { ready: boolean; error?: Error } {
  const { data, error } = useQueryNoThrow(api.orgChanges.get, batch && isConvexId(batch) ? { batch } : "skip");
  const syncTable = useInboxStore((s) => s.syncTable);
  useConvexSync(
    data,
    useCallback((payload: any) => {
      if (!payload) return;
      if (payload.entry) syncTable("orgLog", [payload.entry]);
      syncTable("orgLogRows", payload.rows ?? []);
    }, [syncTable]),
  );
  return { ready: !!batch && data !== undefined, error };
}

/**
 * What an undo (or a redo) of this entry will do, by the server's dry run. A
 * per view read and not stored: it is a question about this moment, asked
 * when the person presses Undo, and its answer is stale the moment anything
 * else changes. `undefined` while the server works, `null` when it cannot say.
 */
export function useOrgUndoPreview(batch: string | null): { preview: OrgUndoPreview | null | undefined; error?: Error } {
  const { data, error } = useQueryNoThrow(api.orgChanges.previewUndo, batch && isConvexId(batch) ? { batch } : "skip");
  return { preview: batch ? (data as OrgUndoPreview | null | undefined) : undefined, error };
}
