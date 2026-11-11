// The feeders of a live artifact's page (board, sheet, dashboard): the
// element revision tail, who is in it, and its versions. They fill the store;
// components/live/useLiveArtifact.ts mounts them and every reader paints from
// the store. Also the write acknowledgement path: once the feed has read past
// a write's revision, the write's field locks go and the server's rows stand.
import { useCallback, useEffect, useState } from "react";
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

/** Hand one elementsSince answer to the store. Returns the revision to ask from next. */
export function applyElementsPayload(payload: any): number {
  const store = useInboxStore.getState() as any;
  const dead: string[] = [];
  const live: any[] = [];
  for (const r of payload.rows ?? []) {
    const id = liveRowId(r.doc_id, r.layer, r.key);
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
  store.syncTable("liveHeads", [{ _id: payload.doc_id, head: payload.head, draft: payload.draft ?? null, title: payload.title, doc_type: payload.doc_type }]);
  const next = payload.next ?? 0;
  if (!payload.more) appliedRev.set(payload.doc_id, Math.max(appliedRev.get(payload.doc_id) ?? 0, payload.head ?? next));
  runSettles();
  return next;
}

// Each open of a page reads the doc from revision 0 once, painting the cached
// rows meanwhile, then follows the tail. Starting from the cache's highest
// revision would trust that the cache holds every write below it, and a cache
// persisted in part (another window's, a write-through cut short) does not: a
// row it missed would never be asked for again.
function useElementsFeed(docId: string): { ready: boolean } {
  const authSettled = useServerAuthSettled();
  const [since, setSince] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setSince(0);
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
