import type { ConvexReactClient } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type InboxSession } from "../store/inboxStore";

// The Killed shelf's one verb: page the next slice of the user's kills
// (listKilledSessions, newest-first) into the never-prune sessions cache and
// record the ids so placeInboxRows lists them in the Killed bucket. A one-shot
// query each click, never a subscription — the ambient sync stays free of
// killed rows on purpose (they are working-set nonmembers on every replica);
// this is the on-demand path for older or never-cached kills. syncTable on
// "sessions" is an additive overlay, so a shelf row can only fill or refresh
// a cached row, never evict one.
const KILLED_SHELF_PAGE = 25;

export async function loadMoreKilledSessions(convex: ConvexReactClient): Promise<void> {
  const shelf = useInboxStore.getState().killedShelf;
  if (shelf.loading || shelf.complete) return;
  useInboxStore.setState({ killedShelf: { ...shelf, loading: true } });
  try {
    const page: any = await convex.query(api.conversations.listKilledSessions, {
      paginationOpts: { numItems: KILLED_SHELF_PAGE, cursor: shelf.cursor },
    });
    const rows: InboxSession[] = page?.page ?? [];
    const store = useInboxStore.getState();
    if (rows.length) store.syncTable("sessions", rows);
    const ids = new Set(store.killedShelf.ids);
    for (const row of rows) ids.add(String(row._id));
    useInboxStore.setState({
      killedShelf: { ids: [...ids], cursor: page?.continueCursor ?? null, complete: !!page?.isDone, loading: false },
    });
  } catch (e) {
    console.error("[killedShelf] load failed", e);
    useInboxStore.setState({ killedShelf: { ...useInboxStore.getState().killedShelf, loading: false } });
    toast.error("Couldn't load older killed sessions");
  }
}
