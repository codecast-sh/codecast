import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

/**
 * Keeps saved views in sync, and carries the old ones across exactly once.
 *
 * Views used to live in the owner's `client_state.ui.saved_views` bag, which is
 * why they could never be shared — there was nowhere for a teammate to read them
 * from. Anyone who saved a view before this change still has theirs in that bag,
 * so on first load we hand each one to the server and clear the bag.
 *
 * The migration is safe to run twice: each legacy view is created under a
 * client_key derived from its old id, and webCreate returns the existing row for
 * a repeat key rather than inserting a second copy.
 */
export function useSyncSavedViews() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const result = useQuery(api.savedViews.webList, activeTeamId ? { team_id: activeTeamId } : {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    // webList returns the COMPLETE set this user can see, so absence is
    // meaningful: a view someone deleted — or stopped sharing — has to leave
    // your rail too. Without the prune, delta mode treats a missing row as
    // "unchanged" and an un-shared view lingers on every teammate's sidebar
    // until they next clear their cache.
    syncTable("savedViews", data as any, { pruneAbsentScope: () => true });
  }, [syncTable]));

  useWatchEffect(() => {
    // Wait for the server list: migrating before it lands would race the very
    // rows we are about to write and could re-create them on the next boot.
    if (result === undefined) return;
    const store = useInboxStore.getState();
    const legacy = store.clientState.ui?.saved_views;
    if (!legacy?.length) return;
    for (const view of legacy) {
      store.createSavedView({
        name: view.name,
        page: view.page,
        prefs: view.prefs,
        client_key: `legacy_${view.id}`,
      });
    }
    // The bag is the old home; leaving rows there would re-migrate every boot.
    store.updateClientUI({ saved_views: [] });
  }, [result !== undefined]);
}
