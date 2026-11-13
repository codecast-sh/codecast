// The one client API for live artifacts (boards, sheets, dashboards). A
// product view never touches Convex or the store directly: it reads elements
// and presence through the hooks here and writes through the handle.
//
// Reads are local-first. useLiveArtifact mounts the feeders (an element
// revision tail, presence, versions) that fill the store; every reader paints
// from the store synchronously.
//
// Writes come in two shapes:
// - apply(ops): a discrete edit. It paints this tick through the store
//   action applyLiveOps and is one dispatch.
// - preview(ops) + commit(): a gesture (a drag, a typing run). Each frame paints
//   from a local overlay at once. The coalesced ops go out at most every
//   FLUSH_MS through apply, and commit() flushes the rest and closes the
//   gesture as ONE undo step.
//
// Undo is a stack of inverse ops per tab. An undo is an ordinary write, so it
// syncs and converges like any edit.
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useAction, useMutation } from "convex/react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  applyOp,
  chunkOps,
  coalesceOps,
  fromElement,
  invertOps,
  isPresenceLive,
  type ArtifactElement,
  type ArtifactOp,
  type ArtifactPosition,
  type ArtifactPresence,
  type ElementState,
} from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { loadOutbox } from "../../store/idbCache";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";
export { applyElementsPayload, settleAfter, storeRowOf } from "../../hooks/useSyncLiveArtifact";
import { onLiveRowsArrived, rowArrivedAt } from "../../hooks/useSyncLiveArtifact";
import { liveRowId, type LiveBatchClaim, type LiveLayer } from "../../store/liveArtifactsSlice";
import { liveReadThrough, restoreServerRows, settleAfter, useSyncLiveArtifact } from "../../hooks/useSyncLiveArtifact";
import { useCoarseNow } from "../../hooks/useCoarseNow";

const FLUSH_MS = 120;
const PRESENCE_MS = 80;
const PRESENCE_BEAT_MS = 10_000;
const UNDO_MAX = 200;

/** One tab's id, so one person in two tabs is two cursors and never sees their own. */
export const LIVE_TAB_ID = tabId();
/** One id per browser tab, kept across reloads (sessionStorage), so a reload is the same cursor, not a second one. */
function tabId(): string {
  try {
    const held = sessionStorage.getItem("live-tab-id");
    if (held) return held;
    const id = nanoid(8);
    sessionStorage.setItem("live-tab-id", id);
    return id;
  } catch {
    return nanoid(8);
  }
}

// ── Store readers ───────────────────────────────────────────────────────────

const ROW_META = new Set(["_id", "doc_id", "layer", "deleted", "dead"]);

// One element object per row object: a row the store did not change hands
// back the same element, so a per-element React.memo holds across recomputes.
const elementOfRow = new WeakMap<object, ArtifactElement>();

/**
 * An element as an overlay state shows it: the state's own fields, whole (a
 * field the write cleared is gone, never the row's old value showing through),
 * with the row's server stamps.
 */
function overlaid(key: string, row: Record<string, any> | undefined, o: ElementState): ArtifactElement {
  return { key, rev: row?.rev ?? 0, ...(row?.by ? { by: row.by } : {}), ...(row?.at ? { at: row.at } : {}), ...(o.fields as any), kind: o.kind } as ArtifactElement;
}

/** A store row as the element a product reads. */
function rowElement(row: Record<string, any>): ArtifactElement {
  const cached = elementOfRow.get(row);
  if (cached) return cached;
  const el: Record<string, any> = {};
  for (const f in row) if (!ROW_META.has(f)) el[f] = row[f];
  elementOfRow.set(row, el as ArtifactElement);
  return el as ArtifactElement;
}

type DocRows = { main: Map<string, any>; draft: Map<string, any>; comments: Map<string, any> };
const EMPTY_ROWS: DocRows = { main: new Map(), draft: new Map(), comments: new Map() };

// Rows grouped per doc, rebuilt only when the liveElements ref changes (any
// element write anywhere), and each doc's group reused when none of its rows
// changed, so a reader re-renders only for its own doc.
let groupedFrom: Record<string, any> | null = null;
let grouped = new Map<string, DocRows>();
function rowsByDoc(coll: Record<string, any> | undefined): Map<string, DocRows> {
  if (!coll) return grouped;
  if (coll === groupedFrom) return grouped;
  const next = new Map<string, DocRows>();
  for (const id in coll) {
    const row = coll[id];
    if (!row) continue;
    let g = next.get(row.doc_id);
    if (!g) next.set(row.doc_id, (g = { main: new Map(), draft: new Map(), comments: new Map() }));
    (g[row.layer as LiveLayer] ?? g.main).set(row.key, row);
  }
  for (const [docId, g] of next) {
    const prev = grouped.get(docId);
    if (prev && sameRows(prev, g)) next.set(docId, prev);
  }
  groupedFrom = coll;
  grouped = next;
  return next;
}
function sameRows(a: DocRows, b: DocRows): boolean {
  for (const l of ["main", "draft", "comments"] as const) {
    if (a[l].size !== b[l].size) return false;
    for (const [k, r] of b[l]) if (a[l].get(k) !== r) return false;
  }
  return true;
}
const rowsOfDoc = (coll: Record<string, any> | undefined, docId: string): DocRows => rowsByDoc(coll).get(docId) ?? EMPTY_ROWS;

export function docRows(docId: string): DocRows {
  return rowsOfDoc((useInboxStore.getState() as any).liveElements, docId);
}

function useDocRows(docId: string): DocRows {
  // While a big write is staged, the page reads the rows it had when the write began (the overlay shows the
  // write itself): the store takes the write a batch at a time, and the page redraws once, at the end.
  return useInboxStore((s: any) => heldRows.get(docId) ?? rowsOfDoc(s.liveElements, docId));
}

/** A chunked restore that stopped partway (see liveArtifacts.restore), or null. */
export function useLiveRestoring(docId: string): { to: number; from: number; by_name: string; at: number } | null {
  return useInboxStore((s: any) => s.liveHeads?.[docId]?.restoring ?? null);
}

/** The doc's pending draft, or null. */
export function useLiveDraftState(docId: string): { by: string; by_name: string; at: number; label?: string } | null {
  return useInboxStore((s: any) => s.liveHeads?.[docId]?.draft ?? null);
}

// ── Preview overlay (gesture state, per tab, never stored) ──────────────────

type Overlay = Map<string, ElementState>;
// What the page shows over the store, per doc: writes queued behind an
// in-flight send, then this tab's open gesture on top. `overlays` is the
// published merge of the two.
const overlays = new Map<string, Overlay>();
const gestureOverlays = new Map<string, Overlay>();
const queuedOverlays = new Map<string, Overlay>();
// Comment writes queued behind a send: their own map, since a comment key is read from the comments layer.
const queuedComments = new Map<string, Overlay>();
const overlayListeners = new Map<string, Set<() => void>>();
function publishOverlay(docId: string) {
  const queued = queuedOverlays.get(docId);
  const gesture = gestureOverlays.get(docId);
  overlays.set(docId, !queued?.size ? gesture ?? new Map() : !gesture?.size ? queued : new Map([...queued, ...gesture]));
  for (const fn of overlayListeners.get(docId) ?? []) fn();
}
function setOverlay(docId: string, next: Overlay) {
  gestureOverlays.set(docId, next);
  publishOverlay(docId);
}
function subscribeOverlay(docId: string, fn: () => void) {
  let set = overlayListeners.get(docId);
  if (!set) overlayListeners.set(docId, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
const EMPTY_OVERLAY: Overlay = new Map();
function useOverlay(docId: string, layer: "page" | "comments" = "page"): Overlay {
  const from = layer === "comments" ? queuedComments : overlays;
  return useSyncExternalStore(
    useCallback((fn) => subscribeOverlay(docId, fn), [docId]),
    () => from.get(docId) ?? EMPTY_OVERLAY,
    () => EMPTY_OVERLAY,
  );
}

// ── Merged view ─────────────────────────────────────────────────────────────

export type LiveReadLayer = "merged" | "main" | "draft" | "comments";

/** The visible state of one key: the gesture overlay, then the draft (when one is open), then main. */
function visibleState(rows: DocRows, overlay: Overlay, key: string, draftOpen: boolean): ElementState | undefined {
  const o = overlay.get(key);
  if (o) return o;
  const d = draftOpen ? rows.draft.get(key) : undefined;
  if (d) return fromElement(d);
  const m = rows.main.get(key);
  return m ? fromElement(m) : undefined;
}

function mergedElements(rows: DocRows, overlay: Overlay, draftOpen: boolean): ArtifactElement[] {
  const out: ArtifactElement[] = [];
  const seen = new Set<string>();
  const take = (key: string, row: any | undefined) => {
    if (seen.has(key)) return;
    seen.add(key);
    const o = overlay.get(key);
    if (o) {
      if (!o.deleted) out.push(overlaid(key, row, o));
      return;
    }
    if (row && !row.deleted) out.push(rowElement(row));
  };
  if (draftOpen) for (const [k, r] of rows.draft) take(k, r);
  for (const [k, r] of rows.main) take(k, r);
  for (const k of overlay.keys()) if (!seen.has(k)) take(k, undefined);
  return out;
}

/**
 * The doc's elements. "merged" (default) is what the page shows: main with
 * the open draft and this tab's gesture laid over it.
 */
export function useLiveElements(docId: string, opts: { kinds?: readonly string[]; layer?: LiveReadLayer } = {}): ArtifactElement[] {
  const rows = useDocRows(docId);
  const overlay = useOverlay(docId);
  const commentsQueued = useOverlay(docId, "comments");
  const draftOpen = !!useLiveDraftState(docId);
  const layer = opts.layer ?? "merged";
  const kindsKey = opts.kinds?.join(",") ?? "";
  return useMemo(() => {
    let els: ArtifactElement[];
    if (layer === "merged") els = mergedElements(rows, overlay, draftOpen);
    else if (layer === "comments" && commentsQueued.size) els = layerElements(rows.comments, commentsQueued);
    else els = [...rows[layer].values()].filter((r) => !r.deleted).map(rowElement);
    if (!kindsKey) return els;
    const kinds = new Set(kindsKey.split(","));
    return els.filter((e) => kinds.has(e.kind));
  }, [rows, overlay, commentsQueued, draftOpen, layer, kindsKey]);
}

/** One layer's rows with queued writes laid over them. */
export function layerElements(layerRows: Map<string, any>, overlay: Overlay): ArtifactElement[] {
  const out: ArtifactElement[] = [];
  for (const [k, r] of layerRows) {
    const o = overlay.get(k);
    if (!o) { if (!r.deleted) out.push(rowElement(r)); continue; }
    if (!o.deleted) out.push(overlaid(k, r, o));
  }
  for (const [k, o] of overlay) if (!layerRows.has(k) && !o.deleted) out.push(overlaid(k, undefined, o));
  return out;
}

/** One element as the page shows it. */
export function useLiveElement(docId: string, key: string): ArtifactElement | undefined {
  const draftOpen = !!useLiveDraftState(docId);
  const row = useInboxStore((s: any) => {
    const coll = s.liveElements;
    return (draftOpen ? coll?.[liveRowId(docId, "draft", key)] : undefined) ?? coll?.[liveRowId(docId, "main", key)];
  });
  const o = useOverlay(docId).get(key);
  return useMemo(() => {
    if (o) return o.deleted ? undefined : overlaid(key, row, o);
    return row && !row.deleted ? rowElement(row) : undefined;
  }, [row, o, key]);
}

/** Everyone else in the artifact now (other tabs and agent sessions). */
export function useLivePresence(docId: string): ArtifactPresence[] {
  const now = useCoarseNow(5_000);
  const rows = useInboxStore((s: any) => s.livePresence);
  return useMemo(() => {
    const out: ArtifactPresence[] = [];
    const mine = `:${LIVE_TAB_ID}`;
    for (const id in rows ?? {}) {
      const p = rows[id];
      if (p?.doc_id !== docId || p.actor.endsWith(mine) || !isPresenceLive(p, now)) continue;
      out.push(p);
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? 1 : -1));
  }, [rows, docId, now]);
}

export type LiveVersion = { _id: string; rev: number; label: string; reason: string; by: string; by_name: string; at: number; elements?: number };

export function useLiveVersions(docId: string): LiveVersion[] {
  // Wakes on this doc's versions only, never another doc's.
  const sig = useInboxStore((s: any) => {
    let out = "";
    for (const id in s.liveVersions ?? {}) { const r = s.liveVersions[id]; if (r?.doc_id === docId) out += `${id}:${r.label}:${r.at};`; }
    return out;
  });
  return useMemo(() => {
    const rows = (useInboxStore.getState() as any).liveVersions;
    const stubs = new Map<number, LiveVersion>();
    for (const id in rows ?? {}) if (rows[id]?.doc_id === docId && rows[id].stub) stubs.set(rows[id].rev, rows[id]);
    // A stub (a version just saved here) stands until the server's row for its revision arrives;
    // a save that renames the row already at this revision shows the new name until the echo carries it.
    const out: LiveVersion[] = [];
    const now = Date.now();
    for (const id in rows ?? {}) {
      const r = rows[id];
      if (r?.doc_id !== docId || r.stub) continue;
      const stub = stubs.get(r.rev);
      stubs.delete(r.rev);
      out.push(stub && stub.label !== r.label && now - stub.at < 60_000 ? { ...r, label: stub.label } : r);
    }
    out.push(...stubs.values());
    return out.sort((a, b) => b.rev - a.rev || b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig is this doc's rows
  }, [sig, docId]);
}

/** Comment pins: the comments layer, roots and replies. */
export function useLiveComments(docId: string): ArtifactElement[] {
  return useLiveElements(docId, { layer: "comments" });
}

// ── Feeders ─────────────────────────────────────────────────────────────────



// One send in flight per doc. The server applies batches in arrival order,
// and two sends racing under load can arrive swapped (a sticky's text `set`
// landing before the `put` that creates it is a no-op, and the text is lost).
// Later writes wait here, painted from the queued overlay, and go out
// coalesced, in order, when the send ahead of them resolves.
/** A whole-range rewrite's claim, as a caller names it (lib/liveArtifactWrite claimsAfter on the server). */
export type LiveClaim = { scope: string; base?: number };
type Queued = { layer: LiveLayer; ops: ArtifactOp[]; claim?: LiveClaim; batchClaims?: LiveBatchClaim[] };
// `staged`: the rest of a write too big for one server batch (a sort of a 10k-row sheet), painted from the
// queued overlay at once and handed to the store one batch per task, so no frame holds the whole write.
type SendQueue = { inflight: boolean; pending: Queued[]; staged: Queued[] };
/** Per doc with a staged write: the rows the page reads until the write is all in the store. */
const heldRows = new Map<string, DocRows>();
const sendQueues = new Map<string, SendQueue>();
const SEND_STALL_MS = 20_000;

function storeState(docId: string, key: string): ElementState | undefined {
  const rows = docRows(docId);
  const draftOpen = !!(useInboxStore.getState() as any).liveHeads?.[docId]?.draft;
  const d = draftOpen ? rows.draft.get(key) : undefined;
  if (d) return fromElement(d);
  const m = rows.main.get(key);
  return m ? fromElement(m) : undefined;
}

function rebuildQueuedOverlay(docId: string) {
  const q = sendQueues.get(docId);
  const next: Overlay = new Map();
  const comments: Overlay = new Map();
  const commentRows = docRows(docId).comments;
  for (const item of [...(q?.staged ?? []), ...(q?.pending ?? [])]) {
    const into = item.layer === "comments" ? comments : next;
    for (const op of item.ops) {
      const stored = item.layer === "comments" ? commentRows.get(op.k) : undefined;
      const prev = into.get(op.k) ?? (item.layer === "comments" ? (stored ? fromElement(stored) : undefined) : storeState(docId, op.k));
      if ("set" in op && (!prev || prev.deleted)) continue;
      into.set(op.k, applyOp(prev, op));
    }
  }
  queuedOverlays.set(docId, next);
  queuedComments.set(docId, comments);
  publishOverlay(docId);
}

// Writes the server has not answered yet, per doc: what the page's save
// state reads. A write counts from its send until the server answers it,
// however long that takes (offline, a stalled socket).
const unsettled = new Map<string, number>();
// The newest write the server refused, per doc, until a later write lands:
// the save state shows it rather than "Saved" over an edit that was undone.
const refused = new Map<string, string>();
// Writes parked for delivery (the dispatch was rewired under them: a reload, a
// hot update). The outbox holds them; while any is parked the page asks it to
// deliver every few seconds, and each counts as waiting until the feed brings
// its rows back.
const parked = new Map<string, Array<{ rowIds: string[]; at: number }>>();
let parkedKick: ReturnType<typeof setInterval> | null = null;
let stopArrivals: (() => void) | null = null;
function settleParked() {
  let changed = false;
  for (const [docId, list] of parked) {
    const left = list.filter((w) => !w.rowIds.every((id) => rowArrivedAt(id) > w.at));
    if (left.length !== list.length) changed = true;
    if (left.length) parked.set(docId, left);
    else parked.delete(docId);
  }
  if (parked.size === 0) {
    if (parkedKick) clearInterval(parkedKick);
    parkedKick = null;
    stopArrivals?.();
    stopArrivals = null;
  }
  if (changed) for (const fn of unsettledListeners) fn();
}
function park(docId: string, rowIds: string[]) {
  parked.set(docId, [...(parked.get(docId) ?? []), { rowIds, at: Date.now() }]);
  for (const fn of unsettledListeners) fn();
  if (!stopArrivals) stopArrivals = onLiveRowsArrived(settleParked);
  if (!parkedKick) parkedKick = setInterval(() => {
    (useInboxStore.getState() as any)._drainOutbox?.();
    settleParked();
  }, 3_000);
}
const parkedCount = (docId: string) => parked.get(docId)?.length ?? 0;
const unsettledListeners = new Set<() => void>();
function countUnsettled(docId: string, delta: number) {
  unsettled.set(docId, Math.max(0, (unsettled.get(docId) ?? 0) + delta));
  for (const fn of unsettledListeners) fn();
}
function refusalText(e: any): string {
  const data = e?.data;
  if (typeof data === "string") return data;
  if (data && typeof data.message === "string") return data.message;
  const m = typeof e?.message === "string" ? e.message.match(/ConvexError: ([^\n]+)/) : null;
  return m?.[1] ?? (typeof e?.message === "string" && !e.message.startsWith("[") ? e.message : "The server refused the edit");
}

/** Why the server refused this tab's newest write to the doc, or null once a write lands. */
export function useLiveRefusal(docId: string): string | null {
  return useSyncExternalStore(
    useCallback((fn) => { unsettledListeners.add(fn); return () => { unsettledListeners.delete(fn); }; }, []),
    () => refused.get(docId) ?? null,
    () => null,
  );
}

// Writes to each doc still in the durable outbox from an earlier page (a reload while they
// were on their way): this page never sent them, but until they replay the doc isn't saved.
// Read while any page shows a save state, every few seconds while some remain.
const outboxWaiting = new Map<string, number>();
let outboxPoll: ReturnType<typeof setTimeout> | null = null;
function pollOutbox() {
  outboxPoll = null;
  if (unsettledListeners.size === 0) return;
  void loadOutbox().then((entries) => {
    const next = new Map<string, number>();
    for (const e of entries as any[]) {
      if (e.action !== "applyLiveOps" || (typeof e.ts === "number" && e.ts >= PAGE_LOAD)) continue;
      const doc = String(e.args?.[0]);
      next.set(doc, (next.get(doc) ?? 0) + 1);
    }
    const changed = next.size !== outboxWaiting.size || [...next].some(([d, n]) => outboxWaiting.get(d) !== n);
    outboxWaiting.clear();
    for (const [d, n] of next) outboxWaiting.set(d, n);
    if (changed) for (const fn of unsettledListeners) fn();
    if (next.size > 0 && !outboxPoll) outboxPoll = setTimeout(pollOutbox, 3000);
  });
}
const PAGE_LOAD = typeof performance !== "undefined" ? performance.timeOrigin : Date.now();

/** How many writes to the doc the server has not answered yet: this tab's, and an earlier page's still replaying. */
export function useLiveUnsettled(docId: string): number {
  return useSyncExternalStore(
    useCallback((fn) => {
      unsettledListeners.add(fn);
      if (!outboxPoll) outboxPoll = setTimeout(pollOutbox, 0);
      return () => { unsettledListeners.delete(fn); };
    }, []),
    () => (unsettled.get(docId) ?? 0) + parkedCount(docId) + (sendQueues.get(docId)?.pending.length ?? 0) + (sendQueues.get(docId)?.staged.length ?? 0) + (outboxWaiting.get(docId) ?? 0),
    () => 0,
  );
}

function dispatchNow(docId: string, layer: LiveLayer, ops: ArtifactOp[], claim?: LiveClaim) {
  const q = sendQueues.get(docId)!;
  q.inflight = true;
  const batches = chunkOps(coalesceOps(ops));
  // Every batch of a claimed rewrite carries the same write id; the last lets the scope go.
  const write = claim ? nanoid(10) : "";
  const claimFor = (i: number): LiveBatchClaim | undefined => (claim ? { scope: claim.scope, write, base: claim.base ?? 0, first: i === 0, last: i === batches.length - 1 } : undefined);
  const [first, ...rest] = batches;
  const firstSend = sendBatch(docId, layer, first, false, claimFor(0));
  const sends: Promise<unknown>[] = [firstSend];
  const finish = () => {
    const stall = new Promise((r) => setTimeout(r, SEND_STALL_MS));
    void Promise.race([Promise.allSettled(sends), stall]).then(() => {
      q.inflight = false;
      drainQueue(docId);
    });
  };
  if (rest.length === 0) return finish();
  // Every batch shows now; the store takes one per task (each store write copies the whole collection once).
  heldRows.set(docId, rowsOfDoc((useInboxStore.getState() as any).liveElements, docId));
  q.staged = rest.map((batch, i) => ({ layer, ops: batch, ...(claim ? { batchClaims: [claimFor(i + 1)!] } : {}) }));
  stageOverlay(docId, layer, rest);
  // The overlay keeps the staged values (the same ones the store takes) until the last batch is in, then
  // steps aside once: one page update for the whole write, not one per batch.
  const dropStaged = () => {
    q.staged = [];
    heldRows.delete(docId);
    rebuildQueuedOverlay(docId);
    finish();
  };
  const pump = () => {
    const item = q.staged.shift();
    if (!item) {
      heldRows.delete(docId);
      rebuildQueuedOverlay(docId);
      return finish();
    }
    // A batch that throws while painting must not strand the rest (or the held rows).
    try { sends.push(sendBatch(docId, item.layer, item.ops, true, item.batchClaims?.[0])); } catch (e) { console.error("[live] staged batch failed", e); }
    nextTask(pump);
  };
  // A rewrite holds its scope only once its first batch is in: the rest goes after that answer, and a
  // refused first batch takes the rest of the write with it (nothing sent, nothing said twice).
  if (claim) void firstSend.then((outcome) => (outcome === "refused" ? dropStaged() : nextTask(pump)));
  else nextTask(pump);
}

/** The next task, without setTimeout's clamping (4 ms nested, a second in a hidden tab), so input runs between batches. */
function nextTask(fn: () => void) {
  if (typeof MessageChannel === "undefined") return void setTimeout(fn, 0);
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); fn(); };
  ch.port2.postMessage(null);
}

/**
 * One server batch: painted in the store now, sent, and settled (or parked, or refused) when it answers.
 * `held`: a staged batch the page reads from its overlay (heldRows), painted with no pending locks.
 */
function sendBatch(docId: string, layer: LiveLayer, batch: ArtifactOp[], held = false, claim?: LiveBatchClaim): Promise<"sent" | "parked" | "refused"> {
  const store = useInboxStore.getState() as any;
  const clientId = nanoid(10);
  let pending: unknown;
  if (held) {
    store.livePaintHeld(docId, layer, batch);
    pending = store.liveSendOps(docId, layer, batch, clientId, claim);
  } else {
    pending = store.applyLiveOps(docId, layer, batch, clientId, claim);
  }
  const before = Date.now();
  const rowIds = batch.map((op) => liveRowId(docId, layer, op.k));
  countUnsettled(docId, 1);
  return Promise.resolve(pending)
    .then((res: any): "sent" => {
      if (res && typeof res.rev === "number") settleAfter(docId, res.rev, rowIds, before);
      refused.delete(docId);
      return "sent";
    })
    .catch((e: any): "parked" | "refused" => {
      if (!isRefusedDispatchError(e)) {
        park(docId, rowIds);
        return "parked";
      }
      // The store already put the rows back (a held batch has no locks to undo: the server's rows go back over it);
      // say so once, and keep it on the save state.
      if (held) restoreServerRows(rowIds);
      const why = refusalText(e);
      if (refused.get(docId) !== why) toast.error(`Not saved: ${why}`);
      refused.set(docId, why);
      return "refused";
    })
    .finally(() => countUnsettled(docId, -1));
}

/** Lay staged batches over the store (each key appears once in a coalesced write, so no batch reads another). */
function stageOverlay(docId: string, layer: LiveLayer, batches: ArtifactOp[][]) {
  const comments = layer === "comments";
  const into = new Map((comments ? queuedComments : queuedOverlays).get(docId) ?? []);
  const commentRows = comments ? docRows(docId).comments : null;
  for (const batch of batches) {
    for (const op of batch) {
      const stored = commentRows?.get(op.k);
      const prev = into.get(op.k) ?? (comments ? (stored ? fromElement(stored) : undefined) : storeState(docId, op.k));
      if ("set" in op && (!prev || prev.deleted)) continue;
      into.set(op.k, applyOp(prev, op));
    }
  }
  (comments ? queuedComments : queuedOverlays).set(docId, into);
  publishOverlay(docId);
}


function drainQueue(docId: string) {
  const q = sendQueues.get(docId);
  if (!q || q.inflight || q.pending.length === 0) return;
  // The next run of same-layer writes goes out as one send; a rewrite with a claim goes alone, whole.
  const first = q.pending[0];
  if (first.claim) {
    q.pending.shift();
    dispatchNow(docId, first.layer, first.ops, first.claim);
    rebuildQueuedOverlay(docId);
    return;
  }
  const layer = first.layer;
  const ops: ArtifactOp[] = [];
  while (q.pending.length && q.pending[0].layer === layer && !q.pending[0].claim) ops.push(...q.pending.shift()!.ops);
  dispatchNow(docId, layer, ops);
  rebuildQueuedOverlay(docId);
}

/**
 * Resolves once every write this tab queued for the doc has gone out, and
 * rejects if they are still waiting after `limitMs` (offline, a stalled
 * socket). A draft closes behind them: a draft edit still queued when the
 * close went first would reopen the draft it was part of, so a close that
 * cannot wait does not happen.
 */
export function whenLiveSent(docId: string, limitMs = 30_000): Promise<void> {
  const idle = () => {
    const q = sendQueues.get(docId);
    return !q || (!q.inflight && q.pending.length === 0);
  };
  if (idle()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (idle()) resolve();
      else if (Date.now() - started > limitMs) reject(new Error("edits still sending"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

/** A rewrite computed before the tab has read the whole doc would write back rows it never saw: refused here, said so. */
function claimReady(docId: string, claim: LiveClaim): boolean {
  if (claim.base !== undefined || liveReadThrough(docId) > 0) return true;
  toast.error("Still loading: try again once it has loaded");
  return false;
}

/** Send a batch for a doc, in order behind any send still in flight. */
export function sendLiveOps(docId: string, layer: LiveLayer, ops: ArtifactOp[], opts?: { claim?: LiveClaim }) {
  if (ops.length === 0) return;
  let q = sendQueues.get(docId);
  if (!q) sendQueues.set(docId, (q = { inflight: false, pending: [], staged: [] }));
  // A rewrite is computed from what this tab has read: its base is the revision the tab holds the whole
  // doc through (never the head a first page announces before the rest arrives), unless the caller knows better.
  const claim = opts?.claim ? { scope: opts.claim.scope, base: opts.claim.base ?? liveReadThrough(docId) } : undefined;
  if (opts?.claim && !claimReady(docId, opts.claim)) return;
  if (!q.inflight) {
    dispatchNow(docId, layer, ops, claim);
    return;
  }
  q.pending.push({ layer, ops, ...(claim ? { claim } : {}) });
  rebuildQueuedOverlay(docId);
  countUnsettled(docId, 0);
}

// ── The handle ──────────────────────────────────────────────────────────────

export type LiveAskInput = {
  prompt: string;
  selection?: string[];
  position?: ArtifactPosition;
  comment_key?: string;
  draft?: boolean;
};

export type LiveHandle = {
  docId: string;
  ready: boolean;
  /**
   * `claim`: the write rewrites a whole range (a sort, a fill, a paste over a range): it owns `scope`
   * ("tab:<id>") until it is all saved, and is refused, put back and said so, if another rewrite holds
   * the scope or someone else wrote into it since this tab read it.
   */
  apply: (ops: ArtifactOp[], opts?: { layer?: LiveLayer; undoable?: boolean; claim?: LiveClaim }) => void;
  preview: (ops: ArtifactOp[]) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  setPresence: (p: { position?: ArtifactPosition; selection?: string[]; status?: string }) => void;
  draft: {
    active: boolean;
    by_name?: string;
    at?: number;
    start: () => void;
    save: () => void;
    discard: () => void;
  };
  history: {
    checkpoint: (label?: string) => void;
    preview: (rev: number) => Promise<ArtifactElement[]>;
    restore: (rev: number) => Promise<{ changed: number }>;
  };
  /** Add a comment pin (and send it to an agent when asked; see AskAgentControl). */
  comment: (c: { anchor?: string; point?: { x: number; y: number }; cell?: string; block?: string; text: string; parent?: string; sent_to?: string }) => string;
};

/**
 * Mount an artifact's feeders and get its write handle. Call once per page;
 * pass the handle down. Every product view receives it as `live`.
 */
export function useLiveArtifact(docId: string): LiveHandle {
  const { ready } = useSyncLiveArtifact(docId);

  const draft = useLiveDraftState(docId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const me = useInboxStore((s: any) => s.currentUser);

  const setPresenceMut = useMutation(api.livePresence.setPresence);
  const leaveMut = useMutation(api.livePresence.leave);
  const stateAt = useAction(api.liveArtifacts.stateAt);
  const restoreAction = useAction(api.liveArtifacts.restore);

  // Undo/redo stacks of inverse batches, with the layer each was written to.
  const undoRef = useRef<Array<{ layer: LiveLayer; ops: ArtifactOp[] }>>([]);
  const redoRef = useRef<Array<{ layer: LiveLayer; ops: ArtifactOp[] }>>([]);
  const [stackTick, setStackTick] = useState(0);

  // The open gesture: ops not yet sent, and the before-state of every key it touched.
  const gesture = useRef<{ pending: ArtifactOp[]; all: ArtifactOp[]; before: Map<string, ElementState | undefined>; timer: any; layer: LiveLayer } | null>(null);

  const writeLayer = useCallback((layer?: LiveLayer): LiveLayer => layer ?? (draftRef.current ? "draft" : "main"), []);
  const stateOf = useCallback(
    (key: string) => visibleState(docRows(docId), overlays.get(docId) ?? EMPTY_OVERLAY, key, !!draftRef.current),
    [docId],
  );

  const send = useCallback((layer: LiveLayer, ops: ArtifactOp[]) => sendLiveOps(docId, layer, ops), [docId]);

  const pushUndo = useCallback((layer: LiveLayer, inverse: ArtifactOp[]) => {
    if (inverse.length === 0) return;
    undoRef.current.push({ layer, ops: inverse });
    if (undoRef.current.length > UNDO_MAX) undoRef.current.shift();
    redoRef.current = [];
    setStackTick((t) => t + 1);
  }, []);

  const apply = useCallback<LiveHandle["apply"]>((ops, opts) => {
    if (ops.length === 0) return;
    const layer = writeLayer(opts?.layer);
    if (opts?.claim && !claimReady(docId, opts.claim)) return;
    if (opts?.undoable !== false && layer !== "comments") pushUndo(layer, invertOps(stateOf, ops));
    if (opts?.claim) sendLiveOps(docId, layer, ops, { claim: opts.claim });
    else send(layer, ops);
  }, [docId, writeLayer, pushUndo, send, stateOf]);

  const flushGesture = useCallback((close: boolean) => {
    const g = gesture.current;
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    const ops = coalesceOps(g.pending);
    g.pending = [];
    // The send paints the store (or the queued overlay): drop those keys from the gesture's overlay.
    const overlay = new Map(gestureOverlays.get(docId) ?? EMPTY_OVERLAY);
    for (const op of ops) overlay.delete(op.k);
    gestureOverlays.set(docId, overlay);
    if (ops.length) send(g.layer, ops);
    publishOverlay(docId);
    if (close) {
      const before = g.before;
      gesture.current = null;
      // Field by field: undoing a drag puts x/y back and leaves a collaborator's text alone.
      pushUndo(g.layer, invertOps((k) => before.get(k), g.all));
    }
  }, [docId, send, stateOf, pushUndo]);

  const preview = useCallback<LiveHandle["preview"]>((ops) => {
    if (ops.length === 0) return;
    let g = gesture.current;
    if (!g) g = gesture.current = { pending: [], all: [], before: new Map(), timer: null, layer: writeLayer() };
    const overlay = new Map(gestureOverlays.get(docId) ?? EMPTY_OVERLAY);
    for (const op of ops) {
      if (!g.before.has(op.k)) g.before.set(op.k, stateOf(op.k));
      const prev = overlay.get(op.k) ?? stateOf(op.k);
      if ("set" in op && (!prev || prev.deleted)) continue;
      overlay.set(op.k, applyOp(prev, op));
      g.pending.push(op);
      g.all.push(op);
    }
    setOverlay(docId, overlay);
    if (!g.timer) g.timer = setTimeout(() => flushGesture(false), FLUSH_MS);
  }, [docId, writeLayer, stateOf, flushGesture]);

  const commit = useCallback(() => flushGesture(true), [flushGesture]);

  const undo = useCallback(() => {
    flushGesture(true);
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push({ layer: entry.layer, ops: invertOps(stateOf, entry.ops) });
    send(entry.layer, entry.ops);
    setStackTick((t) => t + 1);
  }, [flushGesture, stateOf, send]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push({ layer: entry.layer, ops: invertOps(stateOf, entry.ops) });
    send(entry.layer, entry.ops);
    setStackTick((t) => t + 1);
  }, [stateOf, send]);

  // Presence: throttled sends, a beat while the tab is open, leave on unmount.
  const presenceRef = useRef<{ last: any; timer: any; sentAt: number }>({ last: {}, timer: null, sentAt: 0 });
  const sendPresence = useCallback(() => {
    const p = presenceRef.current;
    p.timer = null;
    p.sentAt = Date.now();
    void setPresenceMut({ doc_id: docId as any, tab: LIVE_TAB_ID, ...p.last }).catch(() => {});
  }, [docId, setPresenceMut]);
  const setPresence = useCallback<LiveHandle["setPresence"]>((next) => {
    const p = presenceRef.current;
    p.last = next;
    if (p.timer) return;
    const wait = Math.max(0, PRESENCE_MS - (Date.now() - p.sentAt));
    p.timer = setTimeout(sendPresence, wait);
  }, [sendPresence]);
  useWatchEffect(() => {
    if (!docId) return;
    sendPresence();
    const beat = setInterval(sendPresence, PRESENCE_BEAT_MS);
    return () => {
      clearInterval(beat);
      if (presenceRef.current.timer) clearTimeout(presenceRef.current.timer);
      void leaveMut({ doc_id: docId as any, tab: LIVE_TAB_ID }).catch(() => {});
    };
  }, [docId, sendPresence, leaveMut]);

  // A draft closed anywhere (this tab, another tab, the CLI) takes its undo
  // and redo entries with it: replaying them would open a new draft holding
  // the closed one's edits.
  const draftAt = draft?.at ?? null;
  const lastDraftAt = useRef(draftAt);
  useWatchEffect(() => {
    if (lastDraftAt.current !== null && lastDraftAt.current !== draftAt) {
      undoRef.current = undoRef.current.filter((e) => e.layer !== "draft");
      redoRef.current = redoRef.current.filter((e) => e.layer !== "draft");
      setStackTick((t) => t + 1);
    }
    lastDraftAt.current = draftAt;
  }, [draftAt]);

  // Flush an open gesture when the page goes away.
  useWatchEffect(() => () => flushGesture(true), [flushGesture]);

  const comment = useCallback<LiveHandle["comment"]>((c) => {
    const key = `cm_${nanoid(10)}`;
    const fields: Record<string, any> = { text: c.text, author: me?._id ? `u:${me._id}` : "", author_name: me?.name ?? "You", created_at: Date.now() };
    for (const f of ["anchor", "point", "cell", "block", "parent", "sent_to"] as const) if (c[f] !== undefined) fields[f] = c[f];
    send("comments", [{ k: key, put: { kind: "comment", ...fields } }]);
    return key;
  }, [send, me?._id, me?.name]);

  return useMemo<LiveHandle>(() => ({
    docId,
    ready,
    apply,
    preview,
    commit,
    undo,
    redo,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    setPresence,
    draft: {
      active: !!draft,
      by_name: draft?.by_name,
      at: draft?.at,
      start: () => (useInboxStore.getState() as any).liveDraft(docId, "start"),
      save: () => {
        flushGesture(true);
        undoRef.current = undoRef.current.filter((e) => e.layer !== "draft");
        redoRef.current = redoRef.current.filter((e) => e.layer !== "draft");
        const draftAt = draftRef.current?.at;
        void whenLiveSent(docId).catch(() => {
          toast.error("Edits are still sending, so the draft was not saved; save again once they land");
          return "waiting" as const;
        }).then((waited) => {
        if (waited === "waiting") return;
        const rowIds = [...docRows(docId).draft.keys()].map((k) => liveRowId(docId, "main", k));
        const pending = (useInboxStore.getState() as any).liveDraft(docId, "save", draftAt);
        const before = Date.now();
        return Promise.resolve(pending)
          .then((res: any) => {
            if (res?.stale) toast.error("The draft changed before it was saved; review it and save again");
            else if (res && typeof res.rev === "number") settleAfter(docId, res.rev, rowIds, before);
          })
          .catch(() => {});
        });
      },
      discard: () => {
        flushGesture(true);
        undoRef.current = undoRef.current.filter((e) => e.layer !== "draft");
        redoRef.current = redoRef.current.filter((e) => e.layer !== "draft");
        const draftAt = draftRef.current?.at;
        void whenLiveSent(docId)
          .then(
            () => (useInboxStore.getState() as any).liveDraft(docId, "discard", draftAt),
            () => { toast.error("Edits are still sending, so the draft was kept; discard again once they land"); },
          )
          .then((res: any) => { if (res?.stale) toast.error("The draft changed before it was discarded; look again"); })
          .catch(() => {});
      },
    },
    history: {
      checkpoint: (label) => (useInboxStore.getState() as any).liveCheckpoint(docId, label),
      preview: async (rev) => {
        const rows = await stateAt({ doc_id: docId as any, rev });
        return rows.map((r: any) => ({ ...(r.fields ?? {}), key: r.key, kind: r.kind, rev: 0 }) as ArtifactElement);
      },
      restore: async (rev) => {
        flushGesture(true);
        const r = await restoreAction({ doc_id: docId as any, rev });
        return { changed: r.changed };
      },
    },
    comment,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stackTick re-derives canUndo/canRedo
  }), [docId, ready, apply, preview, commit, undo, redo, setPresence, draft, flushGesture, stateAt, restoreAction, comment, stackTick]);
}
