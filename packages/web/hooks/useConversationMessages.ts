import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, useTrackedStore, isConvexId, ensureHydrated } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { prefetchStorageImageUrls } from "./useStorageImageUrl";
import { rowSigExcluding } from "../store/wakeSig";
import { shareTokenArg } from "../lib/shareTokenScope";

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PENDING: Message[] = [];

// The tail anchor for a fresh visit: one ms below the newest cached row, so
// the still-streaming newest row is inside the subscribed range from the first
// frame. null = cold (no cached rows yet); the cold-open effect resolves it
// via IDB hydration or the one-shot snapshot.
function initTailState(conversationId: string): { id: string; anchor: number | null } {
  const local = useInboxStore.getState().messages[conversationId];
  return {
    id: conversationId,
    anchor: local && local.length > 0 ? local[local.length - 1].timestamp - 1 : null,
  };
}

// Conversation fields that the daemon bumps on every ~1s heartbeat but that don't
// change what the conversation view renders (idle duration is cosmetic and recomputed
// from Date.now() on any render anyway). When two successive conversation objects
// differ ONLY in these fields we hand back the previous object reference, so a bare
// heartbeat no longer rebuilds `conversation` → re-renders the entire 11k-line
// ConversationView monolith (~120ms each, ~4–5×/sec for a live session).
const LIVENESS_ONLY_CONV_FIELDS = new Set([
  "updated_at",
  "last_heartbeat",
  "last_metrics_at",
  "last_active_at",
  "last_message_at",
]);
function conversationRenderEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  if (a === b) return true;
  // The message array is the primary render signal — a new/changed message must
  // always re-render (mergedMessages keeps a stable ref when nothing changed).
  if (a.messages !== b.messages) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    if (LIVENESS_ONLY_CONV_FIELDS.has(k)) continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

// conversationRenderEqual stabilizes the conversation OBJECT, but useTrackedStore
// still WAKES this hook whenever a subscribed row's Object.is identity changes —
// and syncTable hands the session/conversation rows a fresh identity on every
// ~1s liveness bump. A bare heartbeat would therefore re-render InboxConversation
// → ConversationDiffLayout → the (un-memoized) 11k-line ConversationView even
// though nothing visible changed. Subscribing to a SIGNATURE that ignores
// LIVENESS_ONLY_CONV_FIELDS makes a bare heartbeat inert at the source: the dep
// value is unchanged, so the hook never re-renders. Lossless for object-valued
// fields via a stable per-reference id — a real change to a nested object still
// flips the signature. Fail-safe denylist: omit a field and you re-render more
// often, never render stale.
// The single-row signature primitive lives in store/wakeSig.ts (rowSigExcluding);
// the inbox sidebar uses the collection variant (sessionsWakeSig) for the same
// reason. Keep the denylist here — it is conversation-specific.
const metaWakeSig = (row: Record<string, any> | undefined | null): string =>
  rowSigExcluding(row, LIVENESS_ONLY_CONV_FIELDS);

export type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: any[];
  tool_results?: any[];
  images?: any[];
  subtype?: string;
  _isOptimistic?: true;
  _isQueued?: true;
  _clientId?: string;
  _isFailed?: true;
  client_id?: string;
};

// Convex patches the active streaming message in place, so its id and the list
// length stay fixed while content/thinking/tools grow. Keep the cheap structural
// guard, but include the full live tail so partial and final same-id updates are
// never mistaken for an unchanged page.
export function messagePageSyncKey(conversationId: string, messages: Message[]): string {
  return JSON.stringify([
    conversationId,
    messages.length,
    messages[0]?._id,
    messages[messages.length - 1],
  ]);
}

export function useConversationMessages(
  requestedConversationId: string,
  targetMessageId?: string,
  highlightQuery?: string,
  // The target message's already-known timestamp (e.g. from a bookmark row).
  // When supplied, the around-window query can fire on the FIRST render —
  // centered on this value, matching the hover/eager prefetch — instead of
  // waiting a round-trip for getMessageTimestamp. That's what turns a bookmark
  // click into a direct open of the right window rather than tail-then-jump.
  targetTimestamp?: number,
  // Distinguishes a NEW jump request on a long-lived pane. Target
  // initialization latches per conversation, so without this a second jump —
  // same message or a different one — on the same mounted pane never re-fires
  // the around-window query and silently stays put.
  targetNonce?: number
) {
  // Follow the optimistic-create rekey. When a stub conversation resolves to
  // its real Convex id, rekeyId deletes the stub rows in the same store
  // transaction that flips the current-session pointer — but consumers that
  // render through useDeferredValue (InboxConversation) do one more urgent
  // pass with the stale stub id. Without resolution that pass finds no rows,
  // flashes the full-pane loader, and remounts the whole conversation tree.
  const conversationId = useInboxStore((s) => s.resolveLiveSessionId(requestedConversationId));
  const canQuery = isConvexId(conversationId);
  const convId = conversationId as Id<"conversations">;
  // Share-link viewers must PRESENT the token on every read — the server no
  // longer grants "shared" on the token's mere existence (issue #27). Empty
  // for owner/team viewers.
  const shareArg = shareTokenArg(conversationId);

  // Deep-link fallback: when the URL is /conversation/{conversationId}#msg-X and no
  // explicit targetMessageId was supplied, derive it from the hash. This makes deep
  // links work whatever path got us here (full-page load, palette nav, bookmark).
  const [hashTarget] = useState<string | undefined>(() => {
    if (typeof window === "undefined" || !window.location) return undefined;
    const hash = window.location.hash;
    if (!hash.startsWith("#msg-")) return undefined;
    const m = window.location.pathname.match(/^\/conversation\/([^/]+)$/);
    if (!m || m[1] !== conversationId) return undefined;
    return hash.slice(5);
  });
  const effectiveTargetMessageId = targetMessageId ?? hashTarget;

  // --- Target resolution ---
  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    canQuery && effectiveTargetMessageId
      ? { conversation_id: convId, message_id: effectiveTargetMessageId as Id<"messages">, ...shareArg }
      : "skip"
  );

  const cleanedHighlightQuery = highlightQuery?.replace(/^"|"$/g, "").trim();
  const highlightMessageResult = useQuery(
    api.messages.findMessageByContent,
    canQuery && cleanedHighlightQuery
      ? { conversation_id: convId, search_term: cleanedHighlightQuery, ...shareArg }
      : "skip"
  );

  const effectiveTargetTimestamp = targetMessageTimestamp?.timestamp ?? targetTimestamp ?? highlightMessageResult?.timestamp;
  const highlightNotFound = !!(cleanedHighlightQuery && highlightMessageResult === null);
  const targetNotFound = !!(effectiveTargetMessageId && targetMessageTimestamp === null);
  const hasTarget = !!(
    (effectiveTargetMessageId && !targetNotFound) ||
    (cleanedHighlightQuery && !highlightNotFound)
  );
  const targetTimestampReady = hasTarget && effectiveTargetTimestamp !== undefined;

  // --- Mode: target vs normal ---
  const [targetMode, setTargetMode] = useState(hasTarget);
  const [trackedConvId, setTrackedConvId] = useState(conversationId);
  const [jumpTimestamp, setJumpTimestamp] = useState<number | null>(null);
  const [jumpMode, setJumpMode] = useState<"start" | "center" | null>(null);
  // jump-to-end means "leave the target, go to the live tail". The page keeps
  // targetMessageId/highlight set for the WHOLE visit (cleared only on
  // navigate-away — see QueuePageClient scrollTarget), so without remembering
  // the dismissal the render-time sync below would flip targetMode right back
  // on, and the end-jump would complete inside the re-engaged target window
  // ("down arrow just scrolls to the bottom of the top page"). Keyed by target
  // so a NEW deep-link mid-visit still engages target mode.
  const targetKey = effectiveTargetMessageId ?? cleanedHighlightQuery ?? null;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const dismissedTargetKeyRef = useRef<string | null>(null);

  if (trackedConvId !== conversationId) {
    setTrackedConvId(conversationId);
    dismissedTargetKeyRef.current = null;
    setTargetMode(!!(effectiveTargetMessageId || cleanedHighlightQuery));
    setJumpTimestamp(null);
    setJumpMode(null);
  }

  // Derive targetMode from hasTarget (render-time sync). A target the user
  // explicitly dismissed via jump-to-end stays off; any other target value
  // re-engages and clears the dismissal.
  if (hasTarget && !targetMode && dismissedTargetKeyRef.current !== targetKey) {
    dismissedTargetKeyRef.current = null;
    setTargetMode(true);
  }
  if (!hasTarget && jumpTimestamp === null && targetMode) setTargetMode(false);

  // IDB hydration — idempotent, no hooks, tracked by module-level Set
  ensureHydrated(conversationId);

  // =============================================
  // NORMAL MODE: local-first snapshot + live tail
  // =============================================
  // The old shape subscribed usePaginatedQuery(listMessages) as the live path.
  // Its first page is anchored at the NEWEST end of the index, so it grew past
  // 200 rows over a visit and every insert AND every in-place streaming patch
  // re-shipped the entire grown page over the websocket — hundreds of full
  // message bodies per tick for a change that is intrinsically one row.
  //
  // New shape: history is a ONE-SHOT snapshot (or the store/IDB cache — a warm
  // switch pays zero round trips), and the only live subscription is
  // listMessagesTail, covering rows strictly after a fixed anchor. A streaming
  // tick then re-ships the tail (typically 1–30 rows), not the page.
  // Kept alive during a jump-to-START (jumpMode === "start") for the same
  // reason the paginated window was: a cancelled start-jump drops back to an
  // intact window.
  const useNormalMode = (!targetMode || jumpMode === "start") && canQuery;

  // Fork-copy freeze: a freshly forked conversation is seeded locally with the
  // parent's full message window (doFork), while the server copies messages
  // oldest-first in background batches. Until fork_status leaves "copying" the
  // server's window is an incomplete prefix — letting it replace the seeded
  // list would visibly shrink the conversation and regrow it from the top.
  // Freeze snapshot + tail applies (and the recovery loop below) for the
  // duration; the flip to "complete" re-triggers the sync effects and applies
  // the latest server state in one swap.
  const forkCopying = useInboxStore((s) => {
    const meta: any = s.conversations[conversationId] ?? s.sessions[conversationId];
    return meta?.fork_status === "copying";
  });

  const convex = useConvex();

  // The tail anchor is fixed per visit: local rows at or before it are
  // history, rows after it belong to the live tail subscription. null = not
  // yet determined (cold open, snapshot or hydration pending).
  const [tailState, setTailState] = useState<{ id: string; anchor: number | null }>(() => initTailState(conversationId));
  if (tailState.id !== conversationId) setTailState(initTailState(conversationId));
  const tailAnchorRef = useRef<number | null>(null);
  tailAnchorRef.current = tailState.id === conversationId ? tailState.anchor : null;

  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const snapshotInFlightRef = useRef<string | null>(null);

  // One-shot page-1 fetch: cold opens, and the recovery path for deletes /
  // backfill edits (transcript_revision jumps). Replaces the window and
  // re-anchors the tail at the fresh newest row.
  const fetchSnapshot = useCallback(async () => {
    if (snapshotInFlightRef.current === conversationId) return;
    snapshotInFlightRef.current = conversationId;
    setSnapshotLoading(true);
    try {
      const res: any = await convex.query(api.conversations.listMessages, {
        conversation_id: convId,
        paginationOpts: { numItems: 200, cursor: null },
        ...shareTokenArg(conversationId),
      });
      const state = useInboxStore.getState();
      const meta: any = state.conversations[conversationId] ?? state.sessions[conversationId];
      if (meta?.fork_status === "copying" && (state.messages[conversationId]?.length ?? 0) > 0) return;
      const page: Message[] = [...(res?.page ?? [])].reverse();
      state.setMessages(conversationId, page, {
        hasMoreAbove: res ? !res.isDone : false,
        initialized: true,
      });
      setTailState({
        id: conversationId,
        anchor: page.length ? page[page.length - 1].timestamp - 1 : 0,
      });
    } catch (err) {
       
      console.warn("[useConversationMessages] snapshot fetch failed", { conversationId, err });
    } finally {
      snapshotInFlightRef.current = null;
      setSnapshotLoading(false);
    }
  }, [convex, convId, conversationId]);

  // Cold open: wait for the IDB hydration verdict, then either anchor on the
  // cached tail (zero network) or pay the one snapshot round trip.
  // eslint-disable-next-line no-restricted-syntax -- one-shot history load; the tail subscription is the live path
  useEffect(() => {
    if (!useNormalMode || tailState.id !== conversationId || tailState.anchor !== null) return;
    let cancelled = false;
    (async () => {
      await ensureHydrated(conversationId);
      if (cancelled) return;
      const local = useInboxStore.getState().messages[conversationId];
      if (local?.length) {
        setTailState({ id: conversationId, anchor: local[local.length - 1].timestamp - 1 });
        return;
      }
      fetchSnapshot();
    })();
    return () => { cancelled = true; };
  }, [useNormalMode, tailState, conversationId, fetchSnapshot]);

  // The live tail. Anchored one ms before the newest known row so the
  // in-flight streaming row is always inside the subscribed range and its
  // in-place patches replace the local copy.
  const tailResult = useQuery(
    api.conversations.listMessagesTail,
    useNormalMode && tailState.id === conversationId && tailState.anchor !== null
      ? { conversation_id: convId, after_timestamp: tailState.anchor, ...shareArg }
      : "skip"
  );
  useConvexSync(tailResult, useCallback((res: any) => {
    if (!res) return;
    const anchor = tailAnchorRef.current;
    if (anchor === null) return;
    if (forkCopying && (useInboxStore.getState().messages[conversationId]?.length ?? 0) > 0) return;
    useInboxStore.getState().applyTailMessages(conversationId, anchor, res.messages ?? [], res.last_timestamp ?? null);
    // A burst past the server cap: advance the anchor so the next subscription
    // continues from where this result ended.
    if (res.has_more && res.last_timestamp != null) {
      setTailState({ id: conversationId, anchor: res.last_timestamp - 1 });
    }
  }, [conversationId, forkCopying]));

  // Fork completion: the locally seeded window carries the PARENT's row ids;
  // the server's copied rows have new ids the tail (anchored on the seed)
  // never covers. On the copying → complete flip, swap the window for the
  // server's in one snapshot — the wholesale replace the old paginated push
  // used to do.
  const prevForkCopyingRef = useRef(forkCopying);
  // eslint-disable-next-line no-restricted-syntax -- transition-edge refetch
  useEffect(() => {
    const was = prevForkCopyingRef.current;
    prevForkCopyingRef.current = forkCopying;
    if (was && !forkCopying && useNormalMode) fetchSnapshot();
  }, [forkCopying, useNormalMode, fetchSnapshot]);

  // =============================================
  // METADATA: Convex subscription (background sync to store)
  // =============================================
  // strip_volatile: the fat meta payload (fork graph, child map, previews)
  // omits the per-flush counters, so a streaming tick no longer re-pushes it.
  // The counters ride the tiny watermark subscription below instead; syncRecord
  // merges per key, so omitted fields keep their prior store values.
  const remoteMeta = useQuery(
    api.conversations.getConversationWithMeta,
    canQuery ? { conversation_id: convId, strip_volatile: true, ...shareArg } : "skip"
  );

  // The transcript watermark: message_count feeds the recovery poll,
  // transcript_revision flags backfill edits behind the tail anchor. A few
  // integers, so it re-pushes only when one of them actually moves.
  const watermark = useQuery(
    api.conversations.getTranscriptWatermark,
    canQuery ? { conversation_id: convId, ...shareArg } : "skip"
  );
  useConvexSync(watermark, useCallback((w: any) => {
    if (!w) return;
    useInboxStore.getState().syncRecord("conversations", conversationId, w);
  }, [conversationId]));

  useConvexSync(remoteMeta, useCallback((meta: any) => {
    // getConversationWithMeta returns null for missing or access-denied — feeding
    // that into syncRecord trips Object.keys(null) when an existing cache entry
    // is present (inboxStore.ts merge branch). Skip the sync; the cached entry
    // stays put through transient auth blips, and a truly-deleted conversation
    // just stops receiving updates.
    if (!meta) return;
    useInboxStore.getState().syncRecord("conversations", conversationId, meta);
  }, [conversationId]));

  // =============================================
  // USER MESSAGES: full (non-paginated) navigable list → store cache
  // =============================================
  // One subscription, shared by every ConversationView consumer (sticky
  // header, message browser, rewind navigator). Caching the complete list
  // means those features never depend on which message window is paginated in.
  const userMessages = useQuery(
    api.conversations.getUserMessages,
    canQuery ? { conversation_id: convId, ...shareArg } : "skip"
  );
  useConvexSync(userMessages, useCallback((msgs: any) => {
    useInboxStore.getState().setUserMessages(conversationId, msgs);
  }, [conversationId]));

  // Safety net: server-vs-local watermark recovery.
  //
  // The tail subscription is the primary live path, but a safety net stays:
  // reactivity can stall under transient ws blips or while a query is briefly
  // skipped, and the one-shot snapshot is not retried by the framework.
  // Without a fallback, the local store can sit frozen while the server keeps
  // inserting messages — the user sees a stuck conversation.
  //
  // This loop watches storeMeta.message_count (server truth, kept fresh by the
  // watermark subscription) against the local store, in both directions:
  // server ahead → fetch the delta via getNewMessages and merge; local ahead
  // for a sustained stretch → rows were deleted server-side (banner
  // supersession is in tail range, but deleteMessagesByUuid can hit any row) →
  // snapshot refetch. A transcript_revision jump (backfill edit behind the
  // tail anchor) also snapshot-refetches.
  const recoveryInFlightRef = useRef(false);
  const countMismatchRef = useRef<{ id: string; ticks: number }>({ id: conversationId, ticks: 0 });
  const lastRevisionRef = useRef<{ id: string; rev: number } | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- polled recovery; effect manages its own interval
  useEffect(() => {
    if (!canQuery || targetMode) return; // recovery only applies to live normal-mode view

    const tick = async () => {
      if (recoveryInFlightRef.current) return;
      const state = useInboxStore.getState();
      const meta = state.conversations[conversationId] ?? state.sessions[conversationId];
      const local = state.messages[conversationId] ?? [];
      // While a fork copy is in flight the local seeded window is the complete
      // view and the server count is a moving partial — nothing to recover.
      if ((meta as any)?.fork_status === "copying") return;
      // Backfill edit behind the tail anchor: the revision moved, the tail
      // can't see it — refetch the page. First observation per conversation
      // only records the baseline.
      const revision = (meta as any)?.transcript_revision ?? 0;
      if (lastRevisionRef.current?.id !== conversationId) {
        lastRevisionRef.current = { id: conversationId, rev: revision };
      } else if (revision > lastRevisionRef.current.rev) {
        lastRevisionRef.current = { id: conversationId, rev: revision };
        fetchSnapshot();
        return;
      }
      const serverCount = (meta as any)?.message_count ?? 0;
      if (countMismatchRef.current.id !== conversationId) countMismatchRef.current = { id: conversationId, ticks: 0 };
      if (serverCount === 0) return;
      if (local.length > serverCount) {
        // Local ahead can be a benign race (the tail delivered rows before the
        // debounced message_count patch landed) — require it to persist before
        // treating it as a delete and paying a snapshot refetch.
        countMismatchRef.current.ticks++;
        if (countMismatchRef.current.ticks >= 10) {
          countMismatchRef.current.ticks = 0;
          fetchSnapshot();
        }
        return;
      }
      countMismatchRef.current.ticks = 0;
      if (local.length >= serverCount) return;

      recoveryInFlightRef.current = true;
      const after = local.length > 0 ? local[local.length - 1].timestamp : 0;
      try {
        let cursor = after;
        let fetched = 0;
        // Bound the inner pagination loop so a buggy server can't pin us here.
        for (let i = 0; i < 40; i++) {
          const result: any = await convex.query(api.conversations.getNewMessages, {
            conversation_id: convId,
            after_timestamp: cursor,
          });
          // getNewMessages returns null for unauth/no-access — treat as a
          // transient failure and surface in logs so it doesn't silently
          // strand the UI in the loading state.
          if (result === null) {
             
            console.warn("[useConversationMessages] recovery got null (auth not ready?)", { conversationId });
            break;
          }
          if (!result.messages?.length) break;
          useInboxStore.getState().mergeMessages(conversationId, result.messages, "append", { initialized: true });
          fetched += result.messages.length;
          if (!result.has_more || result.last_timestamp == null) break;
          cursor = result.last_timestamp;
        }
        if (fetched > 0) {
           
          console.log("[useConversationMessages] recovery fetched", { conversationId, fetched, serverCount });
        }
      } catch (err) {
         
        console.warn("[useConversationMessages] recovery fetch failed", { conversationId, err });
      } finally {
        recoveryInFlightRef.current = false;
      }
    };

    // Run once immediately so a freshly-opened stuck conversation catches up
    // without waiting a full interval, then poll. 1s cadence — getNewMessages
    // with a current watermark is near-empty, so cost is latency-bound.
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [conversationId, canQuery, targetMode, convex, convId, fetchSnapshot]);

  // =============================================
  // READ FROM STORE (primary source of truth - never waits on Convex)
  // =============================================
  const s = useTrackedStore([
    s => s.messages[conversationId],
    s => s.pendingMessages[conversationId],
    // Wake on render-relevant meta changes only — NOT the ~1s liveness bumps that
    // would otherwise re-render the whole ConversationView tree 4–5×/sec. The full
    // rows are still read live from `s` below; these deps just gate re-renders.
    s => metaWakeSig(s.conversations[conversationId]),
    s => metaWakeSig(s.sessions[conversationId]),
    s => s.pagination[conversationId],
  ]);
  const storeMessages = s.messages[conversationId] ?? EMPTY_MESSAGES;
  const storePending = s.pendingMessages[conversationId] ?? EMPTY_PENDING;
  const _convMeta = s.conversations[conversationId];
  const _sessMeta = s.sessions[conversationId];
  // Merge session data as defaults so the minimal conversations seed ({ _id }) doesn't
  // shadow real session fields like message_count before getConversationWithMeta resolves.
  // Must be memoized: the spread creates a new object every render, which breaks
  // downstream useMemo referential stability and triggers infinite tooltip ref cycles.
  // While a fork copy is in flight, the server reports message_count = fork_copied
  // (a partial that grows 0→N as batches land); hold the rendered count at the
  // locally seeded value so loadedStartIndex/"older messages" UI doesn't bounce.
  const frozenForkCountRef = useRef<{ id: string; count: number } | null>(null);
  const storeMeta = useMemo(() => {
    const merged: any = _convMeta && _sessMeta ? { ..._sessMeta, ..._convMeta } : _convMeta ?? _sessMeta;
    if (merged?.fork_status === "copying") {
      if (frozenForkCountRef.current?.id !== conversationId) {
        frozenForkCountRef.current = { id: conversationId, count: merged.message_count ?? 0 };
      }
      return { ...merged, message_count: Math.max(frozenForkCountRef.current.count, merged.message_count ?? 0) };
    }
    if (frozenForkCountRef.current?.id === conversationId) frozenForkCountRef.current = null;
    return merged;
  }, [_convMeta, _sessMeta, conversationId]);
  const storePagination = s.pagination[conversationId];

  // Merge server messages with unconfirmed pending messages (local-first)
  const mergedMessages: Message[] = useMemo(() => {
    if (storePending.length === 0) return storeMessages;
    // Dedup by both _id (optimistic messages now live in messages[]) and client_id (server-confirmed)
    const storeIds = new Set(storeMessages.map((m: Message) => m._id));
    const serverClientIds = new Set(
      storeMessages.filter((m: Message) => m.client_id).map((m: Message) => m.client_id)
    );
    const unconfirmed = storePending.filter((m: Message) =>
      !storeIds.has(m._id) && (!m._clientId || !serverClientIds.has(m._clientId))
    );
    if (unconfirmed.length === 0) return storeMessages;
    return [...storeMessages, ...unconfirmed].sort((a: Message, b: Message) => a.timestamp - b.timestamp);
  }, [storeMessages, storePending]);

  // Long-visit re-anchor: the tail range grows as messages land; past ~300
  // rows every push re-ships the whole range again, so bump the anchor to just
  // below the newest row. The arg change swaps the subscription; the store
  // already holds everything at or before the new anchor.
  // eslint-disable-next-line no-restricted-syntax -- subscription-window management
  useEffect(() => {
    if (!useNormalMode || tailState.id !== conversationId || tailState.anchor === null) return;
    const local = storeMessages;
    if (local.length === 0) return;
    const anchor = tailState.anchor;
    let inTail = 0;
    for (let i = local.length - 1; i >= 0 && local[i].timestamp > anchor; i--) inTail++;
    if (inTail > 300) {
      setTailState({ id: conversationId, anchor: local[local.length - 1].timestamp - 1 });
    }
  }, [useNormalMode, tailState, conversationId, storeMessages]);

  // =============================================
  // TARGET MODE: getMessagesAroundTimestamp (local state, transient)
  // =============================================
  const [targetAroundData, setTargetAroundData] = useState<any>(null);
  const [targetHasMoreAbove, setTargetHasMoreAbove] = useState(false);
  const [targetHasMoreBelow, setTargetHasMoreBelow] = useState(false);
  const targetInitializedRef = useRef(false);
  // Latches the target id once it lands in the window — see isJumpingToTarget below.
  const targetArrivedRef = useRef<string | null>(null);

  if (trackedConvId !== conversationId) {
    targetInitializedRef.current = false;
    targetArrivedRef.current = null;
    setTargetAroundData(null);
  }

  // A new jump request (new nonce, or a different message) re-arms the target
  // machinery on this same pane: the around-window query fires again and
  // target mode re-engages even after an earlier jump completed or was
  // dismissed via jump-to-end.
  const targetReqKey = `${targetNonce ?? ""}:${effectiveTargetMessageId ?? ""}`;
  const [trackedTargetReqKey, setTrackedTargetReqKey] = useState(targetReqKey);
  if (trackedTargetReqKey !== targetReqKey) {
    setTrackedTargetReqKey(targetReqKey);
    if (effectiveTargetMessageId) {
      targetInitializedRef.current = false;
      targetArrivedRef.current = null;
      dismissedTargetKeyRef.current = null;
      if (!targetMode) setTargetMode(true);
    }
  }

  const aroundData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    canQuery && targetMode && !targetInitializedRef.current && (targetTimestampReady || jumpTimestamp !== null)
      ? {
          conversation_id: convId,
          center_timestamp: jumpTimestamp ?? effectiveTargetTimestamp!,
          limit_before: jumpMode === "start" ? 0 : 50,
          limit_after: jumpMode === "start" ? 100 : 50,
          ...shareArg,
        }
      : "skip"
  );

  // eslint-disable-next-line no-restricted-syntax -- Convex query to local target state with ref guard
  useEffect(() => {
    if (aroundData && !targetInitializedRef.current) {
      targetInitializedRef.current = true;
      setTargetAroundData(aroundData);
      setTargetHasMoreAbove(aroundData.has_more_above ?? false);
      setTargetHasMoreBelow(aroundData.has_more_below ?? false);
    }
  }, [aroundData]);

  const [targetLoadOlderTs, setTargetLoadOlderTs] = useState<number | undefined>(undefined);
  const [targetLoadNewerTs, setTargetLoadNewerTs] = useState<number | undefined>(undefined);
  const [targetIsLoadingOlder, setTargetIsLoadingOlder] = useState(false);
  const [targetIsLoadingNewer, setTargetIsLoadingNewer] = useState(false);

  const olderInTarget = useQuery(
    api.conversations.getAllMessages,
    canQuery && targetMode && targetLoadOlderTs !== undefined
      ? { conversation_id: convId, limit: 50, before_timestamp: targetLoadOlderTs, ...shareArg }
      : "skip"
  );

  const newerInTarget = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    canQuery && targetMode && targetLoadNewerTs !== undefined
      ? { conversation_id: convId, center_timestamp: targetLoadNewerTs, limit_before: 0, limit_after: 50, ...shareArg }
      : "skip"
  );

  // eslint-disable-next-line no-restricted-syntax -- merge older messages into target local state
  useEffect(() => {
    if (olderInTarget && olderInTarget.messages?.length >= 0) {
      setTargetAroundData((prev: any) => {
        if (!prev) return prev;
        const existingIds = new Set(prev.messages.map((m: Message) => m._id));
        const fresh = olderInTarget.messages.filter((m: Message) => !existingIds.has(m._id));
        if (fresh.length === 0) return { ...prev, has_more_above: olderInTarget.has_more_above ?? false };
        return {
          ...prev,
          messages: [...fresh, ...prev.messages].sort((a: Message, b: Message) => a.timestamp - b.timestamp),
          has_more_above: olderInTarget.has_more_above ?? false,
          oldest_timestamp: olderInTarget.oldest_timestamp,
        };
      });
      setTargetHasMoreAbove(olderInTarget.has_more_above ?? false);
      setTargetIsLoadingOlder(false);
      setTargetLoadOlderTs(undefined);
    }
  }, [olderInTarget]);

  // eslint-disable-next-line no-restricted-syntax -- merge newer messages into target local state
  useEffect(() => {
    if (newerInTarget && newerInTarget.messages?.length >= 0) {
      setTargetAroundData((prev: any) => {
        if (!prev) return prev;
        const existingIds = new Set(prev.messages.map((m: Message) => m._id));
        const fresh = newerInTarget.messages.filter((m: Message) => !existingIds.has(m._id));
        if (fresh.length === 0) return { ...prev, has_more_below: newerInTarget.has_more_below ?? false };
        return {
          ...prev,
          messages: [...prev.messages, ...fresh].sort((a: Message, b: Message) => a.timestamp - b.timestamp),
          has_more_below: newerInTarget.has_more_below ?? false,
          last_timestamp: newerInTarget.last_timestamp,
        };
      });
      setTargetHasMoreBelow(newerInTarget.has_more_below ?? false);
      setTargetIsLoadingNewer(false);
      setTargetLoadNewerTs(undefined);
    }
  }, [newerInTarget]);

  // =============================================
  // Unified message list: store for normal mode, local state for target mode
  // =============================================
  const rawMessages: Message[] = targetMode
    // Prefer the local target copy; before the init effect copies it over, read
    // the live around-window query directly so a warm (prefetched) result paints
    // the right window on the FIRST frame instead of the stale tail. Falls back
    // to the cached store list only while the around-window is still loading.
    ? (targetAroundData?.messages ?? aroundData?.messages ?? mergedMessages)
    : mergedMessages;

  // Resolve image URLs as soon as messages arrive — BEFORE the virtualized
  // ImageBlocks mount — so an image scrolled into view never waits on the
  // id→URL round-trip (the bytes themselves are a plain <img> fetch).
  // eslint-disable-next-line no-restricted-syntax -- prefetch side effect keyed to message arrival
  useEffect(() => {
    const ids: string[] = [];
    for (const m of rawMessages) {
      if (!m.images) continue;
      for (const img of m.images) {
        if (img?.storage_id) ids.push(img.storage_id);
      }
    }
    if (ids.length) prefetchStorageImageUrls(convex, ids);
  }, [rawMessages, convex]);

  // =============================================
  // Child conversation map
  // =============================================
  const childByParentUuidMap = useMemo(() => {
    const entries = storeMeta?.child_by_parent_uuid_entries;
    if (Array.isArray(entries)) {
      const map: Record<string, string> = {};
      for (const [parentUuid, childId] of entries) {
        if (typeof parentUuid !== "string" || typeof childId !== "string") continue;
        map[parentUuid] = childId;
      }
      return map;
    }
    return (storeMeta?.child_by_parent_uuid ?? {}) as Record<string, string>;
  }, [storeMeta?.child_by_parent_uuid_entries, storeMeta?.child_by_parent_uuid]);

  const childConversationMap = useMemo(() => {
    if (!childByParentUuidMap || Object.keys(childByParentUuidMap).length === 0) return {};
    const map: Record<string, string> = {};
    for (const msg of rawMessages) {
      if (msg.message_uuid && childByParentUuidMap[msg.message_uuid]) {
        map[msg.message_uuid] = childByParentUuidMap[msg.message_uuid];
      }
    }
    return map;
  }, [childByParentUuidMap, rawMessages]);

  // =============================================
  // Pagination state + actions
  // =============================================
  const hasMoreAbove = targetMode
    ? targetHasMoreAbove
    : (storePagination?.hasMoreAbove ?? false);

  const hasMoreBelow = targetMode ? targetHasMoreBelow : false;

  const [olderLoading, setOlderLoading] = useState(false);

  const isLoadingOlder = targetMode
    ? (targetIsLoadingOlder || (!!jumpMode && !targetInitializedRef.current))
    : olderLoading;

  // In normal mode the "destination" of a jump-to-end is the live tail. While
  // the cold-open snapshot is still in flight the store holds stale/empty
  // content, so the jump-completion effect must treat this as "not ready yet"
  // and hold the scroll — otherwise it scrolls against stale content and then
  // jumps again when the real page lands. A warm switch never sets this.
  const isLoadingNewer = targetMode ? targetIsLoadingNewer : snapshotLoading;

  const loadOlder = useCallback(() => {
    if (targetMode) {
      const msgs = targetAroundData?.messages;
      if (msgs?.length > 0 && targetHasMoreAbove && !targetIsLoadingOlder) {
        setTargetIsLoadingOlder(true);
        setTargetLoadOlderTs(msgs[0].timestamp);
      }
    } else if ((useInboxStore.getState().pagination[conversationId]?.hasMoreAbove ?? false) && !olderLoading) {
      // History pages are one-shot fetches keyed by the oldest local
      // timestamp — no live subscription per page (the old usePaginatedQuery
      // kept every loaded page subscribed and re-executing on churn). 200 per
      // page keeps the walk-back round-trip count low without defeating
      // virtualization.
      const oldest = useInboxStore.getState().messages[conversationId]?.[0]?.timestamp;
      if (oldest === undefined) return;
      setOlderLoading(true);
      convex.query(api.conversations.getAllMessages, {
        conversation_id: convId,
        limit: 200,
        before_timestamp: oldest,
        ...shareTokenArg(conversationId),
      }).then((res: any) => {
        if (!res?.messages) return;
        useInboxStore.getState().mergeMessages(conversationId, res.messages, "prepend", {
          hasMoreAbove: res.has_more_above ?? false,
          initialized: true,
        });
      }).catch((err: unknown) => {
         
        console.warn("[useConversationMessages] loadOlder failed", { conversationId, err });
      }).finally(() => setOlderLoading(false));
    }
  }, [targetMode, targetAroundData, targetHasMoreAbove, targetIsLoadingOlder, olderLoading, convex, convId, conversationId]);

  const loadNewer = useCallback(() => {
    if (targetMode) {
      const msgs = targetAroundData?.messages;
      if (msgs?.length > 0 && targetHasMoreBelow && !targetIsLoadingNewer) {
        setTargetIsLoadingNewer(true);
        setTargetLoadNewerTs(msgs[msgs.length - 1].timestamp);
      }
    }
  }, [targetMode, targetAroundData, targetHasMoreBelow, targetIsLoadingNewer]);

  const jumpToStart = useCallback(() => {
    targetInitializedRef.current = false;
    setTargetAroundData(null);
    setJumpTimestamp(0);
    setJumpMode("start");
    setTargetMode(true);
    setTargetHasMoreAbove(false);
    setTargetHasMoreBelow(true);
    setTargetLoadOlderTs(undefined);
    setTargetLoadNewerTs(undefined);
    setTargetIsLoadingOlder(false);
    setTargetIsLoadingNewer(false);
  }, []);

  const jumpToEnd = useCallback(() => {
    dismissedTargetKeyRef.current = targetKeyRef.current;
    setTargetMode(false);
    targetInitializedRef.current = false;
    setTargetAroundData(null);
    setJumpTimestamp(null);
    setJumpMode(null);
    setTargetLoadOlderTs(undefined);
    setTargetLoadNewerTs(undefined);
    setTargetIsLoadingOlder(false);
    setTargetIsLoadingNewer(false);
  }, []);

  const jumpToTimestamp = useCallback((ts: number) => {
    targetInitializedRef.current = false;
    setTargetAroundData(null);
    setJumpTimestamp(ts);
    setJumpMode("center");
    setTargetMode(true);
    setTargetHasMoreAbove(true);
    setTargetHasMoreBelow(true);
    setTargetLoadOlderTs(undefined);
    setTargetLoadNewerTs(undefined);
    setTargetIsLoadingOlder(false);
    setTargetIsLoadingNewer(false);
  }, []);

  // =============================================
  // Compaction count + loaded_start_index
  // =============================================
  const compactionCount = useMemo(
    () => rawMessages.filter((m) => m.subtype === "compact_boundary").length,
    [rawMessages]
  );

  const loadedStartIndex = useMemo(() => {
    if (targetMode) {
      if (!targetHasMoreAbove) return 0;
      const total = storeMeta?.message_count || rawMessages.length;
      return Math.max(0, total - rawMessages.length);
    }
    if (!hasMoreAbove) return 0;
    const total = storeMeta?.message_count || rawMessages.length;
    return Math.max(0, total - rawMessages.length);
  }, [targetMode, targetHasMoreAbove, hasMoreAbove, storeMeta?.message_count, rawMessages.length]);

  // =============================================
  // Build conversation object FROM STORE (never null if store has pending)
  // =============================================
  const hasPending = storePending.length > 0;
  const rawConversation: Record<string, any> | null = useMemo(() => {
    if (!storeMeta && !hasPending) return null;
    if (!hasPending && targetMode && !targetAroundData && rawMessages.length === 0) return null;
    // Return the conversation immediately with whatever messages are available.
    // The AgentSwitcher's own message_count === 0 guard prevents "new session" flash
    // for sessions that have messages but haven't hydrated from IDB yet.
    return {
      ...(storeMeta || { _id: conversationId, status: "active", message_count: 0 }),
      messages: rawMessages,
      loaded_start_index: loadedStartIndex,
      compaction_count: compactionCount,
      child_conversation_map: childConversationMap,
    };
  }, [storeMeta, rawMessages, loadedStartIndex, compactionCount, childConversationMap, targetMode, targetAroundData, hasPending, conversationId]);

  // Identity-stabilize against liveness-only churn: hand back the prior object when a
  // heartbeat changed nothing the view renders. This is what keeps a working session's
  // ~1s heartbeat from re-rendering the whole ConversationView. (See conversationRenderEqual.)
  const stableConversationRef = useRef<Record<string, any> | null>(null);
  const conversation = useMemo(() => {
    const prev = stableConversationRef.current;
    if (prev && rawConversation && conversationRenderEqual(prev, rawConversation)) {
      return prev;
    }
    stableConversationRef.current = rawConversation;
    return rawConversation;
  }, [rawConversation]);

  // =============================================
  // Target search (auto-load older to find target)
  // =============================================
  const [isSearchingForTarget, setIsSearchingForTarget] = useState(false);
  const searchAttempts = useRef(0);

  // eslint-disable-next-line no-restricted-syntax -- reactive search triggers progressive older-message loading
  useEffect(() => {
    if (!effectiveTargetMessageId || rawMessages.length === 0 || !targetMessageTimestamp) return;
    const found = rawMessages.some((m) => m._id === effectiveTargetMessageId);
    if (found) {
      setIsSearchingForTarget(false);
      searchAttempts.current = 0;
      return;
    }
    if (targetMode && targetHasMoreAbove && !targetIsLoadingOlder && searchAttempts.current < 20) {
      const oldest = rawMessages[0]?.timestamp;
      if (oldest !== undefined && targetMessageTimestamp.timestamp < oldest) {
        setIsSearchingForTarget(true);
        searchAttempts.current += 1;
        setTargetIsLoadingOlder(true);
        setTargetLoadOlderTs(oldest);
      }
    } else {
      setIsSearchingForTarget(false);
    }
  }, [effectiveTargetMessageId, rawMessages, targetMode, targetHasMoreAbove, targetIsLoadingOlder, targetMessageTimestamp]);

  const highlightSearchAttempts = useRef(0);
  // eslint-disable-next-line no-restricted-syntax -- reactive highlight search triggers progressive older-message loading
  useEffect(() => {
    if (!highlightMessageResult || rawMessages.length === 0) return;
    const found = rawMessages.some((m) => m._id === highlightMessageResult.message_id);
    if (found) {
      setIsSearchingForTarget(false);
      highlightSearchAttempts.current = 0;
      return;
    }
    if (targetMode && targetHasMoreAbove && !targetIsLoadingOlder && highlightSearchAttempts.current < 20) {
      const oldest = rawMessages[0]?.timestamp;
      if (oldest !== undefined && highlightMessageResult.timestamp < oldest) {
        setIsSearchingForTarget(true);
        highlightSearchAttempts.current += 1;
        setTargetIsLoadingOlder(true);
        setTargetLoadOlderTs(oldest);
      }
    } else {
      setIsSearchingForTarget(false);
    }
  }, [highlightMessageResult, rawMessages, targetMode, targetHasMoreAbove, targetIsLoadingOlder]);

  // =============================================
  // Target found
  // =============================================
  const targetMessageFound = effectiveTargetMessageId
    ? rawMessages.some((m) => m._id === effectiveTargetMessageId)
    : true;

  // Jump-in-flight: from the moment a target is requested until that message is
  // actually in the rendered window. While the timestamp + around-window queries
  // round-trip, rawMessages still shows the OLD window (deliberate, avoids a blank
  // flash), so without this signal the view gives zero feedback that a jump is
  // happening. Latched per target id: targetMessageId stays set for the whole
  // visit, so a later window swap (jump to end/start) must not re-trigger it.
  if (effectiveTargetMessageId && targetMessageFound) {
    targetArrivedRef.current = effectiveTargetMessageId;
  }
  const isJumpingToTarget =
    (!!effectiveTargetMessageId &&
      canQuery &&
      !targetNotFound &&
      targetArrivedRef.current !== effectiveTargetMessageId) ||
    isSearchingForTarget;

  return {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    jumpToTimestamp,
    isSearchingForTarget,
    targetMessageFound,
    effectiveTargetMessageId,
    isJumpingToTarget,
  };
}
