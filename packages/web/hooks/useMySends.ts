// What the viewer typed into sessions, newest first: the Messages feed's data.
//
// The rows live in `mySends` (store/clientSyncRegistry), persisted, and the
// feed paints from them on the first frame. The cache is meant to be one
// contiguous run from the top of history (hydration keeps the newest rows,
// COLLECTION_RETENTION), filled by:
//   - a live tail of the last few hours (small read set: only the sessions
//     typed into lately);
//   - a walk from the top on each visit, which stops at the first page that
//     reaches a row held before it, closing the gap since the last visit;
//   - older pages from below the oldest held row, on scroll and in idle time
//     up to the cache cap.
// The log can also grow in the MIDDLE (a backfill writes history the cache
// already walked past), which no top-down walk would notice. So once a day
// the walk goes all the way down instead (a sweep), and every page drops the
// held rows of its time range that the server no longer returns.
// Search results never enter mySends (a match below the held window would
// break the run); they sit in mySendSearch.
import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { MySendRow } from "@codecast/convex/convex/userSends";
import { useInboxStore } from "../store/inboxStore";
import { MAX_CACHED_MY_SENDS } from "../store/cacheRetention";
import { applyCollectionFeed, useSyncCollection } from "./useSyncCollection";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useWatchEffect } from "./useWatchEffect";

export type { MySendRow };

const TAIL_WINDOW_MS = 6 * 3600_000;
const PAGE = 400;
/** A cold cache stops its first walk here; the rest comes in idle time. */
const COLD_FIRST = 1200;
const IDLE_GAP_MS = 400;
// The oldest timestamp history has, once a walk reached it this visit.
const END_KEY = "mySends:end";
// When a walk last went all the way down (persisted feed meta).
const SWEPT_KEY = "mySends:sweptAt";
const SWEEP_EVERY_MS = 24 * 3600_000;

const heldRows = () => Object.values(((useInboxStore.getState() as any).mySends ?? {}) as Record<string, MySendRow>);
const oldestHeld = () => heldRows().reduce((min, r) => Math.min(min, r.timestamp), Infinity);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const byNewest = (a: MySendRow, b: MySendRow) => b.timestamp - a.timestamp;
const selectRows = (data: { rows: MySendRow[] } | undefined) => data?.rows;

export function useMySends(): {
  rows: MySendRow[];
  /** Held rows or a first answer exist: the list is not a cold skeleton. */
  ready: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
} {
  const convex = useConvex();
  const authSettled = useServerAuthSettled();
  const coll = useInboxStore((s) => (s as any).mySends) as Record<string, MySendRow> | undefined;
  const rows = useMemo(() => Object.values(coll ?? {}).sort(byNewest), [coll]);
  const endRaw = useInboxStore((s) => s.feedCursors[END_KEY]);
  const end = endRaw == null ? null : Number(endRaw);

  // The tail's window is fixed for the mount, so the subscription is one
  // query for as long as the page is open.
  const [tailAfter] = useState(() => Date.now() - TAIL_WINDOW_MS);
  const tail = useSyncCollection("mySends", api.userSends.mine, { after: tailAfter, limit: 200 }, { select: selectRows });

  const oldest = rows.length ? rows[rows.length - 1].timestamp : null;
  const hasMore = end === null || (oldest !== null && oldest > end);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const busy = useRef(false);
  const caughtUp = useRef(false);

  // One page below `before`, applied as the truth for the time range it
  // covers: a held row in that range the answer lacks is gone.
  const fetchPage = useCallback(async (before: number | undefined) => {
    const page = await convex.query(api.userSends.mine, { ...(before !== undefined ? { before } : {}), limit: PAGE });
    const top = before ?? Infinity;
    const floor = page.nextBefore ?? -Infinity;
    applyCollectionFeed("mySends", page.rows, undefined, undefined, (r: MySendRow) => r.timestamp < top && r.timestamp >= floor);
    if (page.nextBefore === null) {
      const last = page.rows[page.rows.length - 1]?.timestamp ?? before ?? 0;
      useInboxStore.getState().setFeedCursor(END_KEY, String(last));
    }
    return page;
  }, [convex]);

  const loadOlder = useCallback(() => {
    if (busy.current || !caughtUp.current) return;
    const from = oldestHeld();
    const endTs = useInboxStore.getState().feedCursors[END_KEY];
    if (!Number.isFinite(from) || (endTs != null && from <= Number(endTs))) return;
    busy.current = true;
    setLoadingOlder(true);
    fetchPage(from)
      .catch(() => {})
      .finally(() => { busy.current = false; setLoadingOlder(false); });
  }, [fetchPage]);

  useWatchEffect(() => {
    if (!authSettled) return;
    // History can grow below a known end (the log is backfilled), so each
    // visit re-confirms it with one page when the walk gets there.
    useInboxStore.getState().setFeedCursor(END_KEY, null);
    let cancelled = false;
    const run = async () => {
      // Deferred hydration lands a tick after boot; let it, so the walk
      // knows what is already held.
      await sleep(50);
      const st = useInboxStore.getState();
      const heldBefore = new Set(heldRows().map((r) => r._id));
      const sweep = !(Number(st.feedCursors[SWEPT_KEY] ?? 0) > Date.now() - SWEEP_EVERY_MS);
      busy.current = true;
      try {
        let before: number | undefined;
        let walked = 0;
        for (;;) {
          if (cancelled) return;
          const page = await fetchPage(before);
          walked += page.rows.length;
          if (page.nextBefore === null) break;
          if (walked >= MAX_CACHED_MY_SENDS) {
            // A sweep that reached the cap: what lies below is not known to
            // be whole, so it goes (the run stays contiguous).
            if (sweep) {
              const below = heldRows().filter((r) => r.timestamp < page.nextBefore!).map((r) => r._id);
              if (below.length) useInboxStore.getState().dropRows("mySends", below);
            }
            break;
          }
          if (!sweep && page.rows.some((r) => heldBefore.has(r._id))) break;
          if (!sweep && heldBefore.size === 0 && walked >= COLD_FIRST) break;
          before = page.nextBefore;
          // The first screen comes at once; the rest of a sweep is paced.
          if (walked >= COLD_FIRST) await sleep(IDLE_GAP_MS);
        }
        if (sweep) useInboxStore.getState().setFeedCursor(SWEPT_KEY, String(Date.now()));
      } catch {
        return;
      } finally {
        busy.current = false;
      }
      caughtUp.current = true;
      // Fill older history in idle time, up to the cache cap.
      while (!cancelled) {
        await sleep(IDLE_GAP_MS);
        if (cancelled || heldRows().length >= MAX_CACHED_MY_SENDS || !hasMoreNow()) return;
        if (busy.current) continue;
        busy.current = true;
        try { await fetchPage(oldestHeld()); } catch { return; } finally { busy.current = false; }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [authSettled, fetchPage]);

  return { rows, ready: rows.length > 0 || tail.ready, hasMore, loadingOlder, loadOlder };
}

function hasMoreNow(): boolean {
  const end = useInboxStore.getState().feedCursors[END_KEY];
  if (end == null) return true;
  const oldest = oldestHeld();
  return Number.isFinite(oldest) && oldest > Number(end);
}

/** Server matches for a search over everything the viewer typed. */
export function useMySendSearch(q: string): { rows: MySendRow[]; ready: boolean } {
  const query = q.trim();
  const select = useCallback(
    (data: MySendRow[] | undefined) => data?.map((r) => ({ ...r, _id: `${query}\u0000${r._id}`, q: query })),
    [query],
  );
  const opts = useMemo(() => ({ select }), [select]);
  const res = useSyncCollection("mySendSearch", api.userSends.searchMine, query.length >= 2 ? { q: query } : "skip", opts);
  const coll = useInboxStore((s) => (s as any).mySendSearch) as Record<string, MySendRow & { q: string }> | undefined;
  const rows = useMemo(
    () => Object.values(coll ?? {}).filter((r) => r.q === query).map((r) => ({ ...r, _id: r._id.slice(query.length + 1) })),
    [coll, query],
  );
  // A failed search settles too: the cached matches are the answer then.
  return { rows, ready: res.ready || !!res.error };
}

/** The whole text of one send, once opened. */
export function useMySendText(messageId: string | null): string | null {
  const select = useCallback(
    (data: { text: string } | null | undefined) => (data && messageId ? [{ _id: messageId, text: data.text }] : []),
    [messageId],
  );
  const opts = useMemo(() => ({ select }), [select]);
  useSyncCollection("mySendText", api.userSends.fullText, messageId ? { message_id: messageId as any } : "skip", opts);
  return useInboxStore((s) => (messageId ? ((s as any).mySendText?.[messageId]?.text as string | undefined) : undefined)) ?? null;
}
