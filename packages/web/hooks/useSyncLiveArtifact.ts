// The feeders of a live artifact's page (board, sheet, dashboard): the
// element revision tail, who is in it, and its versions. They fill the store;
// components/live/useLiveArtifact.ts mounts them and every reader paints from
// the store. Also the write acknowledgement path: once the feed has read past
// a write's revision, the write's field locks go and the server's rows stand.
import { useCallback, useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { liveRowId } from "../store/liveArtifactsSlice";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useConvexSync } from "./useConvexSync";
import { useSyncCollection, useFeederError } from "./useSyncCollection";

/** A wire row from elementsSince as a flat store row. */
export function storeRowOf(r: any): Record<string, any> {
  return {
    ...(r.fields ?? {}),
    _id: liveRowId(r.doc_id, r.layer, r.key),
    doc_id: r.doc_id,
    layer: r.layer,
    key: r.key,
    kind: r.kind,
    rev: r.rev,
    by: r.by,
    at: r.at,
    ...(r.deleted ? { deleted: true } : {}),
  };
}

// The newest server row per store id and how far each doc's feed has read:
// what a settle re-applies once a write's locks are released.
const serverRows = new Map<string, any>();
// When the feed last brought each row (client clock), and who wants to know:
// a write parked during a rewire counts as delivered once its rows come back.
const arrivedAt = new Map<string, number>();
const arrivalListeners = new Set<() => void>();
export function rowArrivedAt(id: string): number {
  return arrivedAt.get(id) ?? 0;
}
export function onLiveRowsArrived(fn: () => void): () => void {
  arrivalListeners.add(fn);
  return () => { arrivalListeners.delete(fn); };
}
const appliedRev = new Map<string, number>();
type Settle = { docId: string; rev: number; rowIds: string[]; before: number };
let settles: Settle[] = [];

function runSettles() {
  if (settles.length === 0) return;
  const due = settles.filter((x) => (appliedRev.get(x.docId) ?? 0) >= x.rev);
  if (due.length === 0) return;
  settles = settles.filter((x) => !due.includes(x));
  const store = useInboxStore.getState() as any;
  for (const x of due) {
    store.settleLiveRows(x.rowIds, x.before);
    const rows = x.rowIds.map((id) => serverRows.get(id)).filter(Boolean);
    if (rows.length) store.syncTable("liveElements", rows);
  }
}

/** A write landed at `rev`: once the feed has read that far, its locks go and the server's rows stand. */
export function settleAfter(docId: string, rev: number, rowIds: string[], before: number) {
  settles.push({ docId, rev, rowIds, before });
  runSettles();
}

/**
 * The doc's element rows in the store that the server wrote (dead rows are
 * dropped on arrival; tombstones stay). A row this tab made and the server has
 * not stamped yet (rev 0) is left out, so it can never stand in for a server
 * row the cache missed.
 */
function localRowCount(docId: string): number {
  const coll = (useInboxStore.getState() as any).liveElements ?? {};
  let n = 0;
  for (const id in coll) {
    const r = coll[id];
    if (r?.doc_id === docId && Number(r.rev) > 0) n += 1;
  }
  return n;
}

/** Hand one elementsSince answer to the store. Returns the revision to ask from next. */
export function applyElementsPayload(payload: any): number {
  const store = useInboxStore.getState() as any;
  const dead: string[] = [];
  const live: any[] = [];
  const now = Date.now();
  for (const r of payload.rows ?? []) {
    const id = liveRowId(r.doc_id, r.layer, r.key);
    arrivedAt.set(id, now);
    if (r.dead) {
      dead.push(id);
      serverRows.delete(id);
    } else {
      const row = storeRowOf(r);
      live.push(row);
      serverRows.set(id, row);
    }
  }
  if (live.length) store.syncTable("liveElements", live);
  if (dead.length) store.dropRows("liveElements", dead);
  // `complete`: the revision this store holds the whole doc through, set only
  // when the store's rows for the doc number exactly what the server says a
  // complete copy holds. The next open reads the tail from there.
  const complete = !payload.more && typeof payload.total === "number" && localRowCount(payload.doc_id) === payload.total ? payload.head : null;
  store.syncTable("liveHeads", [{ _id: payload.doc_id, head: payload.head, draft: payload.draft ?? null, restoring: payload.restoring ?? null, title: payload.title, doc_type: payload.doc_type, complete, edit: payload.edit ?? "team", editors: payload.editors ?? [], can_edit: payload.can_edit !== false }]);
  const next = payload.next ?? 0;
  if (!payload.more) appliedRev.set(payload.doc_id, Math.max(appliedRev.get(payload.doc_id) ?? 0, payload.head ?? next));
  runSettles();
  if ((payload.rows ?? []).length) for (const fn of arrivalListeners) fn();
  return next;
}

// An open paints the cached rows and reads only the tail past `complete`, the
// revision the cache was last proven whole at (row count equal to the server's).
// The first answer proves it again: a cache persisted in part (a write-through
// cut short, a hydration still running) counts short, and the feed falls back
// to reading the doc from revision 0, so a missed row is always asked for.
const startOf = (docId: string): number => (docId ? Number((useInboxStore.getState() as any).liveHeads?.[docId]?.complete) || 0 : 0);

function useElementsFeed(docId: string): { ready: boolean } {
  const authSettled = useServerAuthSettled();
  const [since, setSince] = useState(() => startOf(docId));
  const [ready, setReady] = useState(false);
  // Whether the read still stands on the cached base and has yet to prove it.
  const unproven = useRef(since > 0);
  useWatchEffect(() => {
    const start = startOf(docId);
    unproven.current = start > 0;
    setSince(start);
    setReady(false);
  }, [docId]);
  const args = authSettled && docId ? { doc_id: docId as any, since } : "skip";
  const { data, error } = useQueryNoThrow(api.liveArtifacts.elementsSince, args as any);
  useFeederError("liveArtifacts.elementsSince", error);
  useConvexSync(
    data,
    useCallback((payload: any) => {
      if (!payload) return;
      const next = applyElementsPayload(payload);
      if (unproven.current && !payload.more) {
        unproven.current = false;
        // The cache counted short (or long): read the whole doc instead.
        if (typeof payload.total !== "number" || localRowCount(payload.doc_id) !== payload.total) {
          setSince(0);
          return;
        }
      }
      if (!payload.more) setReady(true);
      if (next > since) setSince(next);
    }, [since]),
  );
  return { ready };
}

/** Mount every feeder an artifact's page needs. */
export function useSyncLiveArtifact(docId: string): { ready: boolean } {
  const feed = useElementsFeed(docId);
  useSyncCollection("livePresence", api.livePresence.presence, docId ? { doc_id: docId as any } : "skip", {
    select: useCallback((rows: any) => (Array.isArray(rows) ? rows.map((r: any) => ({ ...r, _id: `${r.doc_id}|${r.actor}` })) : rows), []),
    dropAbsent: useCallback((row: any) => row?.doc_id === docId, [docId]),
  });
  useSyncCollection("liveVersions", api.liveArtifacts.versions, docId ? { doc_id: docId as any } : "skip", {
    select: useCallback((p: any) => p?.versions?.map((v: any) => ({ ...v, _id: String(v._id) })), []),
  });
  return feed;
}
