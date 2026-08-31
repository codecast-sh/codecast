import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, isConvexId, ensureHydrated } from "../store/inboxStore";
import { shareTokenArg } from "../lib/shareTokenScope";

// Background warming of inbox conversations so opening one is instant.
//
// The warm order is WHAT THE USER IS LOOKING AT: the store's rendered order
// (visualOrder → placeInboxRows → the view mode, scope, show-old fold and chip
// filters), not the server's live payload. The live window is ~200 rows in
// most-actionable-first order; the flat "All"/"recent" views, the show-old fold,
// a project chip and team scope all draw from the wider local cache, so a loop
// over the payload never touched the rows those views actually show.
//
// Depth is tiered by on-screen rank. The rows at the top of the list get the
// same 200-row page the open path fetches on a cold open (and are deepened to
// it when the cache holds a shorter tail); everything further down gets the
// newest WARM_TAIL_ROWS only. The tiers are what keep "aggressive" bounded:
// warming a thousand rows to 200 image-bearing messages each is the RAM
// balloon the in-memory eviction cap exists to fight.
//
// Three cases per row, in on-screen order:
//   Cold (nothing in memory): restore from IDB, else fetch the newest page.
//   Shallow (in the deep tier, holding fewer than WARM_DEEP_ROWS with older
//     rows on the server): prepend one page — the exact fetch scroll-up does.
//   Stale (message_count grew past what we last synced): append the delta,
//     walking forward from our newest cached message.

/** Newest-page size for rows at the top of the rendered list. Matches the open
 *  path's snapshot page (useConversationMessages), so a warmed row opens with the
 *  same window a cold open would have fetched. */
export const WARM_DEEP_ROWS = 200;
/** How many rows from the top of the rendered list get the deep window. */
export const WARM_DEEP_RANKS = 40;
/** Newest-page size for every row below the deep tier: the slice the
 *  conversation view paints on open, so the click is instant. */
export const WARM_TAIL_ROWS = 60;
/** Cold warms started per pass — a freshly loaded inbox must not fire a query
 *  per row at once; the rest drain over later passes (every list change, every
 *  view change, and the 15s recovery poll). */
export const MAX_COLD_WARM_PER_PASS = 60;
/** Deepen fetches started per pass. */
export const MAX_DEEPEN_PER_PASS = 10;

export type WarmAction =
  | { kind: "cold"; id: string; rows: number; serverCount: number }
  | { kind: "deepen"; id: string; rows: number }
  | { kind: "delta"; id: string; after: number; serverCount: number };

export type WarmRow = {
  id: string;
  serverCount: number;
  storedCount: number;
  hasMoreAbove: boolean;
  /** Newest cached message timestamp (stored rows > 0). */
  newestTs: number | null;
  /** Last message_count we synced up to, if any. */
  syncedCount: number | undefined;
  inFlight: boolean;
};

/** Target window for a row at rank `rank` in the rendered order. */
export function warmDepthForRank(rank: number): number {
  return rank < WARM_DEEP_RANKS ? WARM_DEEP_ROWS : WARM_TAIL_ROWS;
}

/** The pure planner: rows in on-screen order → the bounded fetch list. */
export function planWarm(rows: WarmRow[]): WarmAction[] {
  const actions: WarmAction[] = [];
  let cold = 0;
  let deepens = 0;
  rows.forEach((row, rank) => {
    if (row.inFlight || row.serverCount === 0) return;
    const depth = warmDepthForRank(rank);
    if (row.storedCount === 0) {
      if (cold >= MAX_COLD_WARM_PER_PASS) return;
      cold++;
      actions.push({ kind: "cold", id: row.id, rows: depth, serverCount: row.serverCount });
      return;
    }
    if (row.storedCount < depth && row.hasMoreAbove) {
      if (deepens >= MAX_DEEPEN_PER_PASS) return;
      deepens++;
      actions.push({ kind: "deepen", id: row.id, rows: depth - row.storedCount });
      return;
    }
    if (row.serverCount <= (row.syncedCount ?? 0) || row.newestTs === null) return;
    actions.push({ kind: "delta", id: row.id, after: row.newestTs, serverCount: row.serverCount });
  });
  return actions;
}

type ConvexClient = { query: (fn: any, args: any) => Promise<any> };

// Module state (not hook refs): the personal sync, the team sync, the
// recovery polls and the open path all drive the same loop and must share one
// in-flight set — two callers warming the same row is the duplicate fetch this
// set exists to prevent.
const inFlight = new Set<string>();
// message_count we'd hold if caught up, per conversation. We warm the TAIL, so
// we always hold the newest message — nothing newer exists until message_count
// grows past this. Without it the delta branch re-fires an empty getNewMessages
// every pass for any conversation holding a partial window.
const syncedCount = new Map<string, number>();

/** Prepend up to `limit` older rows before the oldest cached one. The one
 *  history fetch behind scroll-up (useConversationMessages.loadOlder), the
 *  deepen tier and the open-path backfill. Resolves false when there was
 *  nothing local to page back from. */
export async function fetchOlderPage(convex: ConvexClient, conversationId: string, limit: number): Promise<boolean> {
  const oldest = useInboxStore.getState().messages[conversationId]?.[0]?.timestamp;
  if (oldest === undefined) return false;
  const res: any = await convex.query(api.conversations.getAllMessages, {
    conversation_id: conversationId as Id<"conversations">,
    limit,
    before_timestamp: oldest,
    ...shareTokenArg(conversationId),
  });
  if (!res?.messages) return false;
  useInboxStore.getState().mergeMessages(conversationId, res.messages, "prepend", {
    hasMoreAbove: res.has_more_above ?? false,
    initialized: true,
  });
  return true;
}

/** Bring one conversation's cached window up to `rows` if older rows exist —
 *  the open path calls this after anchoring on a short cached tail so the first
 *  scroll-up is already local. Shares the in-flight set with the warm loop. */
export function deepenConversation(convex: ConvexClient, conversationId: string, rows = WARM_DEEP_ROWS): Promise<void> {
  const st = useInboxStore.getState();
  const stored = st.messages[conversationId]?.length ?? 0;
  if (stored === 0 || stored >= rows || !st.pagination[conversationId]?.hasMoreAbove) return Promise.resolve();
  if (inFlight.has(conversationId)) return Promise.resolve();
  inFlight.add(conversationId);
  return fetchOlderPage(convex, conversationId, rows - stored)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => inFlight.delete(conversationId));
}

function runCold(convex: ConvexClient, action: Extract<WarmAction, { kind: "cold" }>) {
  const { id, rows, serverCount } = action;
  inFlight.add(id);
  // A previously-opened session usually still sits in IDB — restore it for
  // free and only go to the network on a real miss. Awaiting the restore is
  // what keeps a relaunch from firing one listMessages per inbox row while the
  // live subscriptions are still fighting for the same server.
  ensureHydrated(id)
    .then((restored) => {
      if (restored) {
        syncedCount.set(id, serverCount);
        return null;
      }
      return convex.query(api.conversations.listMessages, {
        conversation_id: id as Id<"conversations">,
        paginationOpts: { numItems: rows, cursor: null },
      });
    })
    .then((res: any) => {
      if (!res) return;
      const page = res?.page;
      // Don't clobber a window the user opened (or IDB restored) meanwhile —
      // the live tail owns it from that point on.
      if (Array.isArray(page) && page.length > 0 && (useInboxStore.getState().messages[id]?.length ?? 0) === 0) {
        // listMessages is DESC (newest-first); the store holds ASC.
        useInboxStore.getState().setMessages(id, [...page].reverse(), {
          hasMoreAbove: !res.isDone,
          initialized: true,
        });
        syncedCount.set(id, serverCount);
      }
    })
    .catch((err: unknown) => { console.warn("[inboxWarm] cold warm failed", { id, err }); })
    .finally(() => inFlight.delete(id));
}

function runDelta(convex: ConvexClient, action: Extract<WarmAction, { kind: "delta" }>) {
  const { id, serverCount } = action;
  inFlight.add(id);
  const fetchPage = async (after: number): Promise<void> => {
    const result = await convex.query(api.conversations.getNewMessages, {
      conversation_id: id as Id<"conversations">,
      after_timestamp: after,
    });
    if (!result?.messages?.length) return;
    useInboxStore.getState().mergeMessages(id, result.messages, "append", { initialized: true });
    if (result.has_more && result.last_timestamp != null) await fetchPage(result.last_timestamp);
  };
  fetchPage(action.after)
    .then(() => syncedCount.set(id, serverCount))
    .catch((err: unknown) => { console.warn("[inboxWarm] delta warm failed", { id, err }); })
    .finally(() => inFlight.delete(id));
}

function runDeepen(convex: ConvexClient, action: Extract<WarmAction, { kind: "deepen" }>) {
  inFlight.add(action.id);
  fetchOlderPage(convex, action.id, action.rows)
    .catch((err: unknown) => { console.warn("[inboxWarm] deepen failed", { id: action.id, err }); })
    .finally(() => inFlight.delete(action.id));
}

/** Snapshot the rendered list into planner rows. */
export function warmRowsFromState(st: ReturnType<typeof useInboxStore.getState>): WarmRow[] {
  const rows: WarmRow[] = [];
  for (const session of st.visualOrder()) {
    const id = String(session._id);
    if (!isConvexId(id)) continue;
    const msgs = st.messages[id];
    const storedCount = msgs?.length ?? 0;
    rows.push({
      id,
      // The base list omits message_count (fast_fields_in_overlay); the store
      // row is where the overlay has merged the exact value.
      serverCount: st.sessions[id]?.message_count ?? session.message_count ?? 0,
      storedCount,
      hasMoreAbove: st.pagination[id]?.hasMoreAbove ?? false,
      newestTs: storedCount > 0 ? msgs[storedCount - 1].timestamp : null,
      syncedCount: syncedCount.get(id),
      inFlight: inFlight.has(id),
    });
  }
  return rows;
}

// The on-screen set is what message eviction protects (evictInactiveMessages).
// Change-guarded so an identical pass allocates nothing and wakes no subscriber;
// ephemeral state, so a raw set is the right write.
function publishProtectedIds(st: ReturnType<typeof useInboxStore.getState>, rows: WarmRow[]) {
  const prev = st.warmProtectedIds;
  if (prev.size === rows.length && rows.every((r) => prev.has(r.id))) return;
  useInboxStore.setState({ warmProtectedIds: new Set(rows.map((r) => r.id)) });
}

/** One warm pass over what is on screen. Idempotent and cheap when caught up:
 *  visualOrder is memoized on the placement inputs, and every row already at
 *  its tier depth plans to nothing. */
export function warmVisibleSessions(convex: ConvexClient): void {
  const st = useInboxStore.getState();
  const rows = warmRowsFromState(st);
  publishProtectedIds(st, rows);
  const plan = planWarm(rows);
  lastPass = { at: Date.now(), planned: plan.length, kinds: plan.map((a) => a.kind) };
  for (const action of plan) {
    if (action.kind === "cold") runCold(convex, action);
    else if (action.kind === "deepen") runDeepen(convex, action);
    else runDelta(convex, action);
  }
}

// Dev console access (same convention as window.__inboxStore): the last pass
// and the shared in-flight/synced maps, for verifying the loop in a browser.
let lastPass: { at: number; planned: number; kinds: string[] } | null = null;
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as any).__inboxWarm = { get lastPass() { return lastPass; }, inFlight, syncedCount };
}
