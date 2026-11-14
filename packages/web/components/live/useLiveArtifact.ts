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
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
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
  type ArtifactElement,
  type ArtifactOp,
  type ArtifactPosition,
  type ElementState,
} from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { loadOutbox } from "../../store/idbCache";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";
export { applyElementsPayload, settleAfter, storeRowOf } from "../../hooks/useSyncLiveArtifact";
import { onLiveRowsArrived, rowArrivedAt } from "../../hooks/useSyncLiveArtifact";
import { liveRowId, type LiveBatchClaim, type LiveLayer } from "../../store/liveArtifactsSlice";
import { liveReadThrough, restoreServerRows, settleAfter, useSyncLiveArtifact } from "../../hooks/useSyncLiveArtifact";
import {
  EMPTY_OVERLAY,
  LIVE_TAB_ID,
  docRows,
  gestureOverlays,
  heldRows,
  overlays,
  publishOverlay,
  queuedComments,
  queuedOverlays,
  rowsOfDoc,
  setOverlay,
  useLiveDraftState,
  visibleState,
  type DocRows,
  type Overlay,
} from "./liveArtifactReads";
export {
  LIVE_TAB_ID,
  docRows,
  layerElements,
  useLiveComments,
  useLiveDraftState,
  useLiveElement,
  useLiveElements,
  useLivePresence,
  useLiveRestoring,
  useLiveVersions,
  type LiveReadLayer,
  type LiveVersion,
} from "./liveArtifactReads";

const FLUSH_MS = 120;
const PRESENCE_MS = 80;
const PRESENCE_BEAT_MS = 10_000;
const UNDO_MAX = 200;

// ── Feeders ─────────────────────────────────────────────────────────────────



// One send in flight per doc. The server applies batches in arrival order,
// and two sends racing under load can arrive swapped (a sticky's text `set`
// landing before the `put` that creates it is a no-op, and the text is lost).
// Later writes wait here, painted from the queued overlay, and go out
// coalesced, in order, when the send ahead of them resolves.
/** A whole-range rewrite's claim, as a caller names it (lib/liveArtifactWrite claimsAfter on the server). */
export type LiveClaim = { scope: string; base?: number };
/** How a whole write ended: landed (at `rev`), parked for a later send, or refused by the server. */
export type LiveWriteOutcome = { outcome: "sent"; rev: number } | { outcome: "parked" } | { outcome: "refused" };
type Queued = { layer: LiveLayer; ops: ArtifactOp[]; claim?: LiveClaim; batchClaims?: LiveBatchClaim[]; done?: (o: LiveWriteOutcome) => void };
// `staged`: the rest of a write too big for one server batch (a sort of a 10k-row sheet), painted from the
// queued overlay at once and handed to the store one batch per task, so no frame holds the whole write.
type SendQueue = { inflight: boolean; pending: Queued[]; staged: Queued[] };
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

function dispatchNow(docId: string, layer: LiveLayer, ops: ArtifactOp[], claim?: LiveClaim, done?: (o: LiveWriteOutcome) => void) {
  const q = sendQueues.get(docId)!;
  q.inflight = true;
  const batches = chunkOps(coalesceOps(ops));
  // Every batch of a claimed rewrite carries the same write id; the last lets the scope go.
  const write = claim ? nanoid(10) : "";
  const claimFor = (i: number): LiveBatchClaim | undefined => (claim ? { scope: claim.scope, write, base: claim.base ?? 0, first: i === 0, last: i === batches.length - 1 } : undefined);
  const [first, ...rest] = batches;
  const firstSend = sendBatch(docId, layer, first, false, claimFor(0));
  const sends: Promise<LiveWriteOutcome>[] = [firstSend];
  let reported = false;
  const report = (o: LiveWriteOutcome) => { if (!reported) { reported = true; done?.(o); } };
  const finish = () => {
    // The write's outcome: refused if any batch was, parked if any waits, else landed at its last revision.
    void Promise.all(sends).then((all) => {
      if (all.some((o) => o.outcome === "refused")) return report({ outcome: "refused" });
      if (all.some((o) => o.outcome === "parked")) return report({ outcome: "parked" });
      report({ outcome: "sent", rev: Math.max(0, ...all.map((o) => (o.outcome === "sent" ? o.rev : 0))) });
    });
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
  if (claim) void firstSend.then((o) => (o.outcome === "refused" ? dropStaged() : nextTask(pump)));
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
function sendBatch(docId: string, layer: LiveLayer, batch: ArtifactOp[], held = false, claim?: LiveBatchClaim): Promise<LiveWriteOutcome> {
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
    .then((res: any): LiveWriteOutcome => {
      if (res && typeof res.rev === "number") settleAfter(docId, res.rev, rowIds, before);
      refused.delete(docId);
      return { outcome: "sent", rev: typeof res?.rev === "number" ? res.rev : 0 };
    })
    .catch((e: any): LiveWriteOutcome => {
      if (!isRefusedDispatchError(e)) {
        park(docId, rowIds);
        return { outcome: "parked" };
      }
      // The store already put the rows back (a held batch has no locks to undo: the server's rows go back over it);
      // say so once, and keep it on the save state.
      if (held) restoreServerRows(rowIds);
      const why = refusalText(e);
      if (refused.get(docId) !== why) toast.error(`Not saved: ${why}`);
      refused.set(docId, why);
      return { outcome: "refused" };
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
    dispatchNow(docId, first.layer, first.ops, first.claim, first.done);
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
export function sendLiveOps(docId: string, layer: LiveLayer, ops: ArtifactOp[], opts?: { claim?: LiveClaim; done?: (o: LiveWriteOutcome) => void }) {
  if (ops.length === 0) return;
  let q = sendQueues.get(docId);
  if (!q) sendQueues.set(docId, (q = { inflight: false, pending: [], staged: [] }));
  // A rewrite is computed from what this tab has read: its base is the revision the tab holds the whole
  // doc through (never the head a first page announces before the rest arrives), unless the caller knows better.
  const claim = opts?.claim ? { scope: opts.claim.scope, base: opts.claim.base ?? liveReadThrough(docId) } : undefined;
  if (opts?.claim && !claimReady(docId, opts.claim)) return;
  if (!q.inflight) {
    dispatchNow(docId, layer, ops, claim, opts?.done);
    return;
  }
  q.pending.push({ layer, ops, ...(claim ? { claim } : {}), ...(opts?.done ? { done: opts.done } : {}) });
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

  // Undo/redo stacks of inverse batches, with the layer each was written to. An entry for a whole-range
  // rewrite carries its claim scope and, once the write landed, the revision it landed at: taking it back
  // claims the same scope from that revision, so it is refused if someone rewrote the range since,
  // rather than mixing their rows with these. A write the server refused never happened: its entry goes.
  type UndoEntry = { layer: LiveLayer; ops: ArtifactOp[]; scope?: string; landed?: number };
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const [stackTick, setStackTick] = useState(0);

  // The open gesture: ops not yet sent, and the before-state of every key it touched.
  const gesture = useRef<{ pending: ArtifactOp[]; all: ArtifactOp[]; before: Map<string, ElementState | undefined>; timer: any; layer: LiveLayer } | null>(null);

  const writeLayer = useCallback((layer?: LiveLayer): LiveLayer => layer ?? (draftRef.current ? "draft" : "main"), []);
  const stateOf = useCallback(
    (key: string) => visibleState(docRows(docId), overlays.get(docId) ?? EMPTY_OVERLAY, key, !!draftRef.current),
    [docId],
  );

  const send = useCallback((layer: LiveLayer, ops: ArtifactOp[]) => sendLiveOps(docId, layer, ops), [docId]);

  const pushUndo = useCallback((layer: LiveLayer, inverse: ArtifactOp[], scope?: string): UndoEntry | undefined => {
    if (inverse.length === 0) return undefined;
    const entry: UndoEntry = { layer, ops: inverse, ...(scope ? { scope } : {}) };
    undoRef.current.push(entry);
    if (undoRef.current.length > UNDO_MAX) undoRef.current.shift();
    redoRef.current = [];
    setStackTick((t) => t + 1);
    return entry;
  }, []);

  /** Where a claimed write's taking-back entry learns how it ended: landed (at a revision) or refused (gone). */
  const followEntry = useCallback((stack: MutableRefObject<UndoEntry[]>, entry: UndoEntry | undefined) => (o: LiveWriteOutcome) => {
    if (!entry) return;
    if (o.outcome === "sent") entry.landed = o.rev;
    else if (o.outcome === "refused") {
      stack.current = stack.current.filter((e) => e !== entry);
      setStackTick((t) => t + 1);
    }
  }, []);

  /** Send a taking-back entry: a claimed one claims its scope from the revision its write landed at. */
  const sendEntry = useCallback((entry: UndoEntry, follow?: (o: LiveWriteOutcome) => void) => {
    if (entry.scope) sendLiveOps(docId, entry.layer, entry.ops, { claim: { scope: entry.scope, base: entry.landed ?? 0 }, done: follow });
    else send(entry.layer, entry.ops);
  }, [docId, send]);

  const apply = useCallback<LiveHandle["apply"]>((ops, opts) => {
    if (ops.length === 0) return;
    const layer = writeLayer(opts?.layer);
    if (opts?.claim && !claimReady(docId, opts.claim)) return;
    const entry = opts?.undoable !== false && layer !== "comments" ? pushUndo(layer, invertOps(stateOf, ops), opts?.claim?.scope) : undefined;
    if (opts?.claim) sendLiveOps(docId, layer, ops, { claim: opts.claim, done: followEntry(undoRef, entry) });
    else send(layer, ops);
  }, [docId, writeLayer, pushUndo, send, stateOf, followEntry]);

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

  // A claimed write still on its way has no landed revision to take back from: it waits until it lands.
  const stillSaving = (entry: UndoEntry) => {
    if (!entry.scope || entry.landed !== undefined) return false;
    toast("Still saving: undo once it's saved");
    return true;
  };

  const undo = useCallback(() => {
    flushGesture(true);
    const entry = undoRef.current[undoRef.current.length - 1];
    if (!entry || stillSaving(entry)) return;
    undoRef.current.pop();
    const back: UndoEntry = { layer: entry.layer, ops: invertOps(stateOf, entry.ops), ...(entry.scope ? { scope: entry.scope } : {}) };
    redoRef.current.push(back);
    sendEntry(entry, followEntry(redoRef, back));
    setStackTick((t) => t + 1);
  }, [flushGesture, stateOf, sendEntry, followEntry]);

  const redo = useCallback(() => {
    const entry = redoRef.current[redoRef.current.length - 1];
    if (!entry || stillSaving(entry)) return;
    redoRef.current.pop();
    const back: UndoEntry = { layer: entry.layer, ops: invertOps(stateOf, entry.ops), ...(entry.scope ? { scope: entry.scope } : {}) };
    undoRef.current.push(back);
    sendEntry(entry, followEntry(undoRef, back));
    setStackTick((t) => t + 1);
  }, [stateOf, sendEntry, followEntry]);

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
