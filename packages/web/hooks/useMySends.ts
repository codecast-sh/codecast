// What the viewer typed into sessions, newest first: the Messages feed's data.
//
// The rows live in `mySends` (store/clientSyncRegistry), persisted, and the
// feed paints from them on the first frame. Hydration keeps the newest rows
// only (COLLECTION_RETENTION), so the held rows are always one contiguous run
// from the top of history, and every fetch keeps it that way:
//   - a live tail of the last few hours (small read set: only the sessions
//     typed into lately);
//   - a catch-up walk from the top that stops as soon as a page reaches a row
//     that was already held, which closes the gap since the last visit;
//   - older pages, always from below the oldest held row, on scroll and in
//     idle time up to the cache cap.
// Search results never enter mySends (a match below the held window would
// break the run); they sit in mySendSearch.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { MySendRow } from "@codecast/convex/convex/userSends";
import { useInboxStore } from "../store/inboxStore";
import { MAX_CACHED_MY_SENDS } from "../store/cacheRetention";
import { useSyncCollection } from "./useSyncCollection";
import { useServerAuthSettled } from "./useServerAuthSettled";

export type { MySendRow };

const TAIL_WINDOW_MS = 6 * 3600_000;
const PAGE = 400;
/** A cold cache stops its first walk here; the rest comes in idle time. */
const COLD_FIRST = 1200;
const IDLE_GAP_MS = 400;
// The oldest timestamp history has, once a walk reached it this visit.
const END_KEY = "mySends:end";

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

  const fetchPage = useCallback(async (before: number | undefined) => {
    const page = await convex.query(api.userSends.mine, { ...(before !== undefined ? { before } : {}), limit: PAGE });
    useInboxStore.getState().syncTable("mySends", page.rows);
    if (page.nextBefore === null) {
      const last = page.rows[page.rows.length - 1]?.timestamp ?? before ?? 0;
      useInboxStore.getState().setFeedCursor(END_KEY, String(last));
    }
    return page;
  }, [convex]);

  const loadOlder = useCallback(() => {
    if (busy.current || !caughtUp.current) return;
    const st = useInboxStore.getState();
    const held = Object.values(((st as any).mySends ?? {}) as Record<string, MySendRow>);
    if (!held.length) return;
    const from = Math.min(...held.map((r) => r.timestamp));
    const endTs = st.feedCursors[END_KEY];
    if (endTs != null && from <= Number(endTs)) return;
    busy.current = true;
    setLoadingOlder(true);
    fetchPage(from)
      .catch(() => {})
      .finally(() => { busy.current = false; setLoadingOlder(false); });
  }, [fetchPage]);

  // Catch up from the top until a page reaches a row held before the walk
  // began, then fill older history in idle time up to the cache cap.
  useEffect(() => {
    if (!authSettled) return;
    // History can grow below a known end (the log is backfilled), so each
    // visit re-confirms it with one page when the walk gets there.
    useInboxStore.getState().setFeedCursor(END_KEY, null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heldIds = () => new Set(Object.keys(((useInboxStore.getState() as any).mySends ?? {})));
    const run = async () => {
      // Deferred hydration lands a tick after boot; let it, so the walk
      // knows what is already held.
      await new Promise((r) => setTimeout(r, 50));
      const before0 = heldIds();
      busy.current = true;
      try {
        let before: number | undefined;
        let walked = 0;
        for (;;) {
          if (cancelled) return;
          const page = await fetchPage(before);
          walked += page.rows.length;
          const connected = page.rows.some((r) => before0.has(r._id));
          if (connected || page.nextBefore === null) break;
          if (before0.size === 0 && walked >= COLD_FIRST) break;
          before = page.nextBefore;
        }
      } catch {
        return;
      } finally {
        busy.current = false;
      }
      caughtUp.current = true;
      const idle = () => {
        if (cancelled) return;
        const n = Object.keys(((useInboxStore.getState() as any).mySends ?? {})).length;
        const st = useInboxStore.getState();
        if (n >= MAX_CACHED_MY_SENDS || (st.feedCursors[END_KEY] != null && !hasMoreNow())) return;
        if (busy.current) { timer = setTimeout(idle, IDLE_GAP_MS); return; }
        busy.current = true;
        const held = Object.values(((st as any).mySends ?? {}) as Record<string, MySendRow>);
        const from = held.length ? Math.min(...held.map((r) => r.timestamp)) : undefined;
        fetchPage(from)
          .then(() => { timer = setTimeout(idle, IDLE_GAP_MS); })
          .catch(() => {})
          .finally(() => { busy.current = false; });
      };
      timer = setTimeout(idle, IDLE_GAP_MS);
    };
    void run();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [authSettled, fetchPage]);

  return { rows, ready: rows.length > 0 || tail.ready, hasMore, loadingOlder, loadOlder };
}

function hasMoreNow(): boolean {
  const st = useInboxStore.getState();
  const end = st.feedCursors[END_KEY];
  if (end == null) return true;
  const held = Object.values(((st as any).mySends ?? {}) as Record<string, MySendRow>);
  return held.length > 0 && Math.min(...held.map((r) => r.timestamp)) > Number(end);
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
