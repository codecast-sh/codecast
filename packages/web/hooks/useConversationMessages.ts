import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { useQuery, usePaginatedQuery, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, useTrackedStore, isConvexId, ensureHydrated } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PENDING: Message[] = [];

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
let __metaRefSeq = 0;
const __metaRefIds = new WeakMap<object, number>();
const metaRefId = (o: object): number => {
  let id = __metaRefIds.get(o);
  if (id === undefined) { id = ++__metaRefSeq; __metaRefIds.set(o, id); }
  return id;
};
function metaWakeSig(row: Record<string, any> | undefined | null): string {
  if (!row) return "∅";
  let sig = "";
  for (const k in row) {
    if (LIVENESS_ONLY_CONV_FIELDS.has(k)) continue;
    const v = row[k];
    sig += k + ":" + (v !== null && typeof v === "object" ? "#" + metaRefId(v) : String(v)) + ";";
  }
  return sig;
}

type Message = {
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

export function useConversationMessages(
  requestedConversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
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
      ? { conversation_id: convId, message_id: effectiveTargetMessageId as Id<"messages"> }
      : "skip"
  );

  const cleanedHighlightQuery = highlightQuery?.replace(/^"|"$/g, "").trim();
  const highlightMessageResult = useQuery(
    api.messages.findMessageByContent,
    canQuery && cleanedHighlightQuery
      ? { conversation_id: convId, search_term: cleanedHighlightQuery }
      : "skip"
  );

  const effectiveTargetTimestamp = targetMessageTimestamp?.timestamp ?? highlightMessageResult?.timestamp;
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
  // NORMAL MODE: Convex paginated subscription (background sync)
  // =============================================
  // Kept alive during a jump-to-START (jumpMode === "start") even though that
  // is technically target mode. Reason: usePaginatedQuery resets to its
  // initial page when its args flip to "skip" and back, which would collapse
  // the loaded window. Keeping it mounted preserves the accumulated pages so a
  // CANCELLED start-jump can drop straight back to the exact scroll position
  // (the window never shrank out from under the user). Deep-link / timestamp
  // target navigation (jumpMode "center" or a targetMessageId) still turns it
  // off — those genuinely replace the view and don't need the live window.
  const useNormalMode = (!targetMode || jumpMode === "start") && canQuery;

  const { results: descResults, status: paginationStatus, loadMore } = usePaginatedQuery(
    api.conversations.listMessages,
    useNormalMode ? { conversation_id: convId } : "skip",
    // 200 (was 40): measured fetch cost is round-trip dominated — p50 ~370ms
    // at 40 vs ~410-630ms at 200 on real conversations — while client cost is
    // flat in window size (store write ~4ms, render virtualized). 40 gave
    // only ~2-3 screenfuls before hitting a load boundary; 200 matches the
    // loadOlder page so the first page and every subsequent one are one unit.
    { initialNumItems: 200 }
  );

  // Ref avoids re-creating the sync callback when paginationStatus changes,
  // which would re-trigger useConvexSync's effect and loop: setMessages → re-render → new callback → effect → setMessages …
  const paginationStatusRef = useRef(paginationStatus);
  paginationStatusRef.current = paginationStatus;

  // Fork-copy freeze: a freshly forked conversation is seeded locally with the
  // parent's full message window (doFork), while the server copies messages
  // oldest-first in background batches. Until fork_status leaves "copying" the
  // server's window is an incomplete prefix — letting it replace the seeded
  // list would visibly shrink the conversation and regrow it from the top.
  // Freeze the paginated sync (and the recovery loop below) for the duration;
  // the flip to "complete" changes this value, which re-triggers the
  // useConvexSync effect and applies the latest full server page in one swap.
  const forkCopying = useInboxStore((s) => {
    const meta: any = s.conversations[conversationId] ?? s.sessions[conversationId];
    return meta?.fork_status === "copying";
  });

  // Sync Convex paginated results → Zustand store.
  // Guard: skip setMessages when the message list is unchanged to break the
  // re-render loop (setMessages → Zustand notify → re-render → effect → …).
  const lastSyncedRef = useRef<{ id: string; len: number; first?: string; last?: string } | null>(null);

  useConvexSync(
    useNormalMode && paginationStatus !== "LoadingFirstPage" ? descResults : undefined,
    useCallback((results: any) => {
      if (forkCopying && (useInboxStore.getState().messages[conversationId]?.length ?? 0) > 0) return;
      const messages: Message[] = [...results].reverse();
      const sig = { id: conversationId, len: messages.length, first: messages[0]?._id, last: messages[messages.length - 1]?._id };
      const prev = lastSyncedRef.current;
      if (prev && prev.id === sig.id && prev.len === sig.len && prev.first === sig.first && prev.last === sig.last) return;
      lastSyncedRef.current = sig;
      useInboxStore.getState().setMessages(conversationId, messages, {
        hasMoreAbove: paginationStatusRef.current === "CanLoadMore" || paginationStatusRef.current === "LoadingMore",
        initialized: true,
      });
    }, [conversationId, forkCopying])
  );

  // =============================================
  // METADATA: Convex subscription (background sync to store)
  // =============================================
  const remoteMeta = useQuery(
    api.conversations.getConversationWithMeta,
    canQuery ? { conversation_id: convId } : "skip"
  );

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
    canQuery ? { conversation_id: convId } : "skip"
  );
  useConvexSync(userMessages, useCallback((msgs: any) => {
    useInboxStore.getState().setUserMessages(conversationId, msgs);
  }, [conversationId]));

  // Safety net: server-vs-local watermark recovery.
  //
  // usePaginatedQuery above is the primary sync path, but its reactivity can
  // stall: after loadMore() bounds the first page, during conversation_id
  // transitions, under transient ws blips, or when the query is briefly
  // skipped. Without a fallback, the local store can sit frozen while the
  // server keeps inserting messages — the user sees a stuck conversation.
  //
  // This loop watches storeMeta.message_count (server truth, kept fresh by
  // the getConversationWithMeta subscription) against the local store. When
  // they diverge, fetch the delta via getNewMessages and merge — same path
  // useSyncInboxSessions.bgSyncMessages uses, just driven per-conversation.
  const convex = useConvex();
  const recoveryInFlightRef = useRef(false);
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
      const serverCount = (meta as any)?.message_count ?? 0;
      if (serverCount === 0 || local.length >= serverCount) return;
      // Don't pile on while the initial paginated query is still inflight on
      // the very first tick — let it land if it's going to. After it settles
      // (Exhausted/CanLoadMore), recovery is the authoritative path even if
      // status briefly flips back to LoadingFirstPage during reactivity blips.

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
            // eslint-disable-next-line no-console
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
          // eslint-disable-next-line no-console
          console.log("[useConversationMessages] recovery fetched", { conversationId, fetched, serverCount });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
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
  }, [conversationId, canQuery, targetMode, convex, convId]);

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

  const aroundData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    canQuery && targetMode && !targetInitializedRef.current && (targetTimestampReady || jumpTimestamp !== null)
      ? {
          conversation_id: convId,
          center_timestamp: jumpTimestamp ?? effectiveTargetTimestamp!,
          limit_before: jumpMode === "start" ? 0 : 50,
          limit_after: jumpMode === "start" ? 100 : 50,
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
      ? { conversation_id: convId, limit: 50, before_timestamp: targetLoadOlderTs }
      : "skip"
  );

  const newerInTarget = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    canQuery && targetMode && targetLoadNewerTs !== undefined
      ? { conversation_id: convId, center_timestamp: targetLoadNewerTs, limit_before: 0, limit_after: 50 }
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
    ? (targetAroundData?.messages ?? mergedMessages)
    : mergedMessages;

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

  const isLoadingOlder = targetMode
    ? (targetIsLoadingOlder || (!!jumpMode && !targetInitializedRef.current))
    : paginationStatus === "LoadingMore";

  // In normal mode the "destination" of a jump-to-end is the live tail. While
  // its first page is still being fetched (LoadingFirstPage) the store holds
  // stale/empty content, so the jump-completion effect must treat this as "not
  // ready yet" and hold the scroll — otherwise it scrolls against stale content
  // and then jumps again when the real page lands. The button itself is hidden
  // at the bottom, so this never surfaces a spurious spinner on initial load.
  const isLoadingNewer = targetMode ? targetIsLoadingNewer : (paginationStatus === "LoadingFirstPage");

  const loadOlder = useCallback(() => {
    if (targetMode) {
      const msgs = targetAroundData?.messages;
      if (msgs?.length > 0 && targetHasMoreAbove && !targetIsLoadingOlder) {
        setTargetIsLoadingOlder(true);
        setTargetLoadOlderTs(msgs[0].timestamp);
      }
    } else if (paginationStatus === "CanLoadMore") {
      // Larger page = far fewer round-trips to walk back through history.
      // This was loadMore(50), which made reaching the top of a long
      // conversation take dozens of tiny fetches; 200 keeps it snappy while
      // staying bounded (the old loadMore(10000) defeated virtualization).
      loadMore(200);
    }
  }, [targetMode, targetAroundData, targetHasMoreAbove, targetIsLoadingOlder, paginationStatus, loadMore]);

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
