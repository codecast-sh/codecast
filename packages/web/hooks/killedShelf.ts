import type { ConvexReactClient } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type InboxSession } from "../store/inboxStore";

// The Closed shelf's one verb: page the next slice of the user's kills
// (listKilledSessions) and closes (listClosedSessions), each newest-first on
// its own cursor, into the never-prune sessions cache, and record the ids so
// placeInboxRows lists them in the Closed bucket. A one-shot query each click,
// never a subscription: kills are working-set nonmembers on every replica, and
// closes are members only inside the scan's recency window, so this is the
// on-demand path for older or never-cached ones. syncTable on "sessions" is an
// additive overlay, so a shelf row can only fill or refresh a cached row,
// never evict one.
const KILLED_SHELF_PAGE = 25;

type Page = { page: InboxSession[]; isDone: boolean; continueCursor: string | null };

export async function loadMoreKilledSessions(convex: ConvexReactClient): Promise<void> {
  const shelf = useInboxStore.getState().killedShelf;
  if (shelf.loading || shelf.complete) return;
  useInboxStore.setState({ killedShelf: { ...shelf, loading: true } });
  try {
    const none: Page = { page: [], isDone: true, continueCursor: null };
    const [killed, closed] = await Promise.all([
      shelf.killedDone ? none : convex.query(api.conversations.listKilledSessions, { paginationOpts: { numItems: KILLED_SHELF_PAGE, cursor: shelf.cursor } }) as Promise<Page>,
      shelf.closedDone ? none : convex.query(api.conversations.listClosedSessions, { paginationOpts: { numItems: KILLED_SHELF_PAGE, cursor: shelf.closedCursor } }) as Promise<Page>,
    ]);
    const rows = [...(killed?.page ?? []), ...(closed?.page ?? [])];
    const store = useInboxStore.getState();
    if (rows.length) store.syncTable("sessions", rows);
    const ids = new Set(store.killedShelf.ids);
    for (const row of rows) ids.add(String(row._id));
    const killedDone = shelf.killedDone || !!killed?.isDone;
    const closedDone = shelf.closedDone || !!closed?.isDone;
    useInboxStore.setState({
      killedShelf: {
        ids: [...ids],
        cursor: shelf.killedDone ? shelf.cursor : killed?.continueCursor ?? null,
        closedCursor: shelf.closedDone ? shelf.closedCursor : closed?.continueCursor ?? null,
        killedDone,
        closedDone,
        complete: killedDone && closedDone,
        loading: false,
      },
    });
  } catch (e) {
    console.error("[killedShelf] load failed", e);
    useInboxStore.setState({ killedShelf: { ...useInboxStore.getState().killedShelf, loading: false } });
    toast.error("Couldn't load older closed sessions");
  }
}
