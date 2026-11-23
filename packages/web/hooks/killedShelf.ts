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

// A page can come back empty but not done (the query filters within a page):
// keep paging until one yields rows or both sources are drained. A source that
// fails stops for this click; the other keeps its rows.
export async function loadMoreKilledSessions(convex: ConvexReactClient): Promise<void> {
  const shelf = useInboxStore.getState().killedShelf;
  if (shelf.loading || shelf.complete) return;
  useInboxStore.setState({ killedShelf: { ...shelf, loading: true } });
  let { cursor, closedCursor, killedDone, closedDone } = shelf;
  let killedFailed = false;
  let closedFailed = false;
  const rows: InboxSession[] = [];
  const page = (fn: typeof api.conversations.listKilledSessions | typeof api.conversations.listClosedSessions, at: string | null) =>
    convex.query(fn, { paginationOpts: { numItems: KILLED_SHELF_PAGE, cursor: at } }) as Promise<Page>;
  while (rows.length === 0 && ((!killedDone && !killedFailed) || (!closedDone && !closedFailed))) {
    const [killed, closed] = await Promise.allSettled([
      killedDone || killedFailed ? null : page(api.conversations.listKilledSessions, cursor),
      closedDone || closedFailed ? null : page(api.conversations.listClosedSessions, closedCursor),
    ]);
    if (killed.status === "rejected") { killedFailed = true; console.error("[killedShelf] kills failed", killed.reason); }
    else if (killed.value) { rows.push(...killed.value.page); cursor = killed.value.continueCursor; killedDone = killed.value.isDone; }
    if (closed.status === "rejected") { closedFailed = true; console.error("[killedShelf] closes failed", closed.reason); }
    else if (closed.value) { rows.push(...closed.value.page); closedCursor = closed.value.continueCursor; closedDone = closed.value.isDone; }
  }
  const store = useInboxStore.getState();
  if (rows.length) store.syncTable("sessions", rows);
  const ids = new Set(store.killedShelf.ids);
  for (const row of rows) ids.add(String(row._id));
  useInboxStore.setState({
    killedShelf: { ids: [...ids], cursor, closedCursor, killedDone, closedDone, complete: killedDone && closedDone, loading: false },
  });
  if (killedFailed || closedFailed) toast.error("Couldn't load older closed sessions");
}
