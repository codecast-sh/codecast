import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, useTrackedStore, isConvexId, ensureHydrated } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PENDING: Message[] = [];

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
  conversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
) {
  const canQuery = isConvexId(conversationId);
  const convId = conversationId as Id<"conversations">;

  // Deep-link fallback: when the URL is /conversation/{conversationId}#msg-X and no
  // explicit targetMessageId was supplied, derive it from the hash. This makes deep
  // links work whatever path got us here (full-page load, palette nav, bookmark).
  const [hashTarget] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const hash = window.location.hash;
    if (!hash.startsWith("#msg-")) return undefined;
    const m = window.location.pathname.match(/^\/conversation\/([^/]+)$/);
    if (!m || m[1] !== conversationId) return undefined;
    return hash.slice(5);
  });
  const effectiveTargetMessageId = targetMessageId ?? hashTarget;
  if (typeof window !== "undefined" && (window as any).__deeplinkDbg__) {
    console.log('[deeplink:hook] cid=' + conversationId + ' tgt=' + targetMessageId + ' hash=' + hashTarget + ' eff=' + effectiveTargetMessageId);
  }

  // --- Target resolution ---
  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    canQuery && effectiveTargetMessageId
      ? { conversation_id: convId, message_id: effectiveTargetMessageId as Id<"messages"> }
      : "skip"
  );
  if (typeof window !== "undefined" && (window as any).__deeplinkDbg__ && effectiveTargetMessageId) {
    console.log('[deeplink:hook] tsResult=' + JSON.stringify(targetMessageTimestamp));
  }

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

  if (trackedConvId !== conversationId) {
    setTrackedConvId(conversationId);
    setTargetMode(!!(effectiveTargetMessageId || cleanedHighlightQuery));
    setJumpTimestamp(null);
    setJumpMode(null);
  }

  // Derive targetMode from hasTarget (deleted the useEffect, using render-time sync)
  if (hasTarget && !targetMode) setTargetMode(true);
  if (!hasTarget && jumpTimestamp === null && targetMode) setTargetMode(false);

  // IDB hydration — idempotent, no hooks, tracked by module-level Set
  ensureHydrated(conversationId);

  // =============================================
  // NORMAL MODE: Convex paginated subscription (background sync)
  // =============================================
  const useNormalMode = !targetMode && canQuery;

  const { results: descResults, status: paginationStatus, loadMore } = usePaginatedQuery(
    api.conversations.listMessages,
    useNormalMode ? { conversation_id: convId } : "skip",
    { initialNumItems: 100 }
  );

  // Ref avoids re-creating the sync callback when paginationStatus changes,
  // which would re-trigger useConvexSync's effect and loop: setMessages → re-render → new callback → effect → setMessages …
  const paginationStatusRef = useRef(paginationStatus);
  paginationStatusRef.current = paginationStatus;

  // Sync Convex paginated results → Zustand store.
  // Guard: skip setMessages when the message list is unchanged to break the
  // re-render loop (setMessages → Zustand notify → re-render → effect → …).
  const lastSyncedRef = useRef<{ id: string; len: number; first?: string; last?: string } | null>(null);

  useConvexSync(
    useNormalMode && paginationStatus !== "LoadingFirstPage" ? descResults : undefined,
    useCallback((results: any) => {
      const messages: Message[] = [...results].reverse();
      const sig = { id: conversationId, len: messages.length, first: messages[0]?._id, last: messages[messages.length - 1]?._id };
      const prev = lastSyncedRef.current;
      if (prev && prev.id === sig.id && prev.len === sig.len && prev.first === sig.first && prev.last === sig.last) return;
      lastSyncedRef.current = sig;
      useInboxStore.getState().setMessages(conversationId, messages, {
        hasMoreAbove: paginationStatusRef.current === "CanLoadMore" || paginationStatusRef.current === "LoadingMore",
        initialized: true,
      });
    }, [conversationId])
  );

  // =============================================
  // METADATA: Convex subscription (background sync to store)
  // =============================================
  const remoteMeta = useQuery(
    api.conversations.getConversationWithMeta,
    canQuery ? { conversation_id: convId } : "skip"
  );

  useConvexSync(remoteMeta, useCallback((meta: any) => {
    useInboxStore.getState().syncRecord("conversations", conversationId, meta);
  }, [conversationId]));

  // =============================================
  // READ FROM STORE (primary source of truth - never waits on Convex)
  // =============================================
  const s = useTrackedStore([
    s => s.messages[conversationId],
    s => s.pendingMessages[conversationId],
    s => s.conversations[conversationId],
    s => s.sessions[conversationId],
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
  const storeMeta = useMemo(
    () => _convMeta && _sessMeta ? { ..._sessMeta, ..._convMeta } : _convMeta ?? _sessMeta,
    [_convMeta, _sessMeta],
  );
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

  if (trackedConvId !== conversationId) {
    targetInitializedRef.current = false;
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
    ? targetIsLoadingOlder
    : paginationStatus === "LoadingMore";

  const isLoadingNewer = targetMode ? targetIsLoadingNewer : false;

  const loadOlder = useCallback(() => {
    if (targetMode) {
      const msgs = targetAroundData?.messages;
      if (msgs?.length > 0 && targetHasMoreAbove && !targetIsLoadingOlder) {
        setTargetIsLoadingOlder(true);
        setTargetLoadOlderTs(msgs[0].timestamp);
      }
    } else if (paginationStatus === "CanLoadMore") {
      loadMore(50);
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
  const conversation: Record<string, any> | null = useMemo(() => {
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
  };
}
