import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
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
  // Repair before the first push lands, so a client carrying tombstones from the
  // short-lived pruning build gets its views back on this boot rather than
  // staying mysteriously short one view forever. A no-op for everyone else.
  useWatchEffect(() => {
    useInboxStore.getState().clearSavedViewTombstones();
  }, []);
  // useQueryNoThrow, not useQuery: this hook mounts inside Sidebar, and saved
  // views only enrich the rail. A terminal server error — the classic one being
  // "Could not find public function" in the window between the web code going
  // live and the convex deploy landing — must degrade to "no saved views", not
  // unmount the whole sidebar into its ErrorBoundary.
  const { data: result } = useQueryNoThrow(
    api.savedViews.webList,
    // A just-created team carries an optimistic stub id until the server
    // echoes; a stub is not an Id<"teams">, so skip for that window.
    activeTeamId && !isConvexId(String(activeTeamId))
      ? "skip"
      : activeTeamId
        ? { team_id: activeTeamId }
        : {},
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    // webList returns the COMPLETE set this user can see, so the registry keeps
    // savedViews OUT of delta mode: a plain replace makes a view someone
    // deleted — or stopped sharing — leave your rail too. Deliberately NOT
    // pruneAbsentScope, which marks absent rows with a DURABLE tombstone: the
    // list is legitimately empty for a beat while auth settles, and pruning on
    // that beat hides every view you own for good. A replace self-heals on the
    // next push; a tombstone never does.
    syncTable("savedViews", data as any);
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
