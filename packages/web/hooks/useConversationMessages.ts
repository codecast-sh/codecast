import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

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
  _clientId?: string;
  client_id?: string;
};

export function useConversationMessages(
  conversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
) {
  const canQuery = isConvexId(conversationId);
  const convId = conversationId as Id<"conversations">;

  // --- Target resolution ---
  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    canQuery && targetMessageId
      ? { conversation_id: convId, message_id: targetMessageId as Id<"messages"> }
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
  const targetNotFound = !!(targetMessageId && targetMessageTimestamp === null);
  const hasTarget = !!(
    (targetMessageId && !targetNotFound) ||
    (cleanedHighlightQuery && !highlightNotFound)
  );
  const targetTimestampReady = hasTarget && effectiveTargetTimestamp !== undefined;

  // --- Mode: target vs normal ---
  const [targetMode, setTargetMode] = useState(hasTarget);
  const [trackedConvId, setTrackedConvId] = useState(conversationId);
  const [jumpTimestamp, setJumpTimestamp] = useState<number | null>(null);

  if (trackedConvId !== conversationId) {
    setTrackedConvId(conversationId);
    setTargetMode(!!(targetMessageId || cleanedHighlightQuery));
    setJumpTimestamp(null);
  }

  // Derive targetMode from hasTarget (deleted the useEffect, using render-time sync)
  if (hasTarget && !targetMode) setTargetMode(true);
  if (!hasTarget && jumpTimestamp === null && targetMode) setTargetMode(false);

  // =============================================
  // NORMAL MODE: Convex paginated subscription (background sync)
  // =============================================
  const useNormalMode = !targetMode && canQuery;

  const { results: descResults, status: paginationStatus, loadMore } = usePaginatedQuery(
    api.conversations.listMessages,
    useNormalMode ? { conversation_id: convId } : "skip",
    { initialNumItems: 100 }
  );

  useConvexSync(
    useNormalMode && paginationStatus !== "LoadingFirstPage" ? descResults : undefined,
    useCallback((results: any) => {
      const messages: Message[] = [...results].reverse();
      useInboxStore.getState().setMessages(conversationId, messages, {
        hasMoreAbove: paginationStatus === "CanLoadMore" || paginationStatus === "LoadingMore",
        initialized: true,
      });
    }, [conversationId, paginationStatus])
  );

  // =============================================
  // METADATA: Convex subscription (background sync to store)
  // =============================================
  const remoteMeta = useQuery(
    api.conversations.getConversationWithMeta,
    canQuery ? { conversation_id: convId } : "skip"
  );

  useConvexSync(remoteMeta, useCallback((meta: any) => {
    useInboxStore.getState().setConversationMeta(conversationId, meta);
  }, [conversationId]));

  // =============================================
  // READ FROM STORE (primary source of truth - never waits on Convex)
  // =============================================
  const storeMessages = useInboxStore((s) => s.messages[conversationId]) ?? [];
  const storePending = useInboxStore((s) => s.pendingMessages[conversationId]) ?? [];
  const storeMeta = useInboxStore((s) => s.conversations[conversationId]);
  const storePagination = useInboxStore((s) => s.pagination[conversationId]);

  // Merge server messages with unconfirmed pending messages (local-first)
  const mergedMessages: Message[] = useMemo(() => {
    if (storePending.length === 0) return storeMessages;
    const serverClientIds = new Set(
      storeMessages.filter((m: Message) => m.client_id).map((m: Message) => m.client_id)
    );
    const unconfirmed = storePending.filter((m: Message) =>
      !m._clientId || !serverClientIds.has(m._clientId)
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
          limit_before: jumpTimestamp !== null ? 0 : 150,
          limit_after: jumpTimestamp !== null ? 300 : 150,
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
      ? { conversation_id: convId, limit: 150, before_timestamp: targetLoadOlderTs }
      : "skip"
  );

  const newerInTarget = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    canQuery && targetMode && targetLoadNewerTs !== undefined
      ? { conversation_id: convId, center_timestamp: targetLoadNewerTs, limit_before: 0, limit_after: 150 }
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
  const childConversationMap = useMemo(() => {
    if (!storeMeta?.child_by_parent_uuid) return {};
    const map: Record<string, string> = {};
    for (const msg of rawMessages) {
      if (msg.message_uuid && storeMeta.child_by_parent_uuid[msg.message_uuid]) {
        map[msg.message_uuid] = storeMeta.child_by_parent_uuid[msg.message_uuid];
      }
    }
    return map;
  }, [storeMeta?.child_by_parent_uuid, rawMessages]);

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
  // Build conversation object FROM STORE (never null if store has meta)
  // =============================================
  const conversation: Record<string, any> | null = useMemo(() => {
    if (!storeMeta) return null;
    if (targetMode && !targetAroundData && rawMessages.length === 0) return null;
    if (useNormalMode && mergedMessages.length === 0 && (storeMeta?.message_count ?? 0) > 0 && !storePagination?.initialized) return null;
    return {
      ...storeMeta,
      messages: rawMessages,
      loaded_start_index: loadedStartIndex,
      compaction_count: compactionCount,
      child_conversation_map: childConversationMap,
    };
  }, [storeMeta, rawMessages, loadedStartIndex, compactionCount, childConversationMap, targetMode, targetAroundData, mergedMessages.length, useNormalMode, storePagination?.initialized]);

  // =============================================
  // Target search (auto-load older to find target)
  // =============================================
  const [isSearchingForTarget, setIsSearchingForTarget] = useState(false);
  const searchAttempts = useRef(0);

  // eslint-disable-next-line no-restricted-syntax -- reactive search triggers progressive older-message loading
  useEffect(() => {
    if (!targetMessageId || rawMessages.length === 0 || !targetMessageTimestamp) return;
    const found = rawMessages.some((m) => m._id === targetMessageId);
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
  }, [targetMessageId, rawMessages, targetMode, targetHasMoreAbove, targetIsLoadingOlder, targetMessageTimestamp]);

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
  const targetMessageFound = targetMessageId
    ? rawMessages.some((m) => m._id === targetMessageId)
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
    isSearchingForTarget,
    targetMessageFound,
  };
}
