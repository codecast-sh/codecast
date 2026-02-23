import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, Message, PaginationState } from "../store/inboxStore";

const MAX_SEARCH_ATTEMPTS = 20;

export function useSyncConversationMessages(
  conversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
) {
  const isTempId = conversationId.startsWith("temp_");

  const pag = useInboxStore((s) => s.pagination[conversationId]) as PaginationState | undefined;
  const initialized = pag?.initialized ?? false;
  const lastTimestamp = pag?.lastTimestamp ?? null;
  const oldestTimestamp = pag?.oldestTimestamp ?? null;
  const hasMoreAbove = pag?.hasMoreAbove ?? false;
  const hasMoreBelow = pag?.hasMoreBelow ?? false;
  const isLoadingOlder = pag?.isLoadingOlder ?? false;
  const isLoadingNewer = pag?.isLoadingNewer ?? false;
  const loadOlderTimestamp = pag?.loadOlderTimestamp;
  const loadNewerTimestamp = pag?.loadNewerTimestamp;
  const jumpMode = pag?.jumpMode ?? null;

  const searchAttempts = useRef(0);
  const highlightSearchAttempts = useRef(0);
  const initializedRef = useRef(initialized);
  initializedRef.current = initialized;

  const store = useInboxStore;

  useEffect(() => {
    store.getState().initPagination(conversationId);
  }, [conversationId]);

  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    !isTempId && targetMessageId
      ? {
          conversation_id: conversationId as Id<"conversations">,
          message_id: targetMessageId as Id<"messages">,
        }
      : "skip"
  );

  const cleanedHighlightQuery = highlightQuery?.replace(/^"|"$/g, "").trim();
  const highlightMessageResult = useQuery(
    api.messages.findMessageByContent,
    !isTempId && cleanedHighlightQuery
      ? {
          conversation_id: conversationId as Id<"conversations">,
          search_term: cleanedHighlightQuery,
        }
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

  const aroundData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    !isTempId && targetTimestampReady && !initializedRef.current
      ? {
          conversation_id: conversationId as Id<"conversations">,
          center_timestamp: effectiveTargetTimestamp!,
          limit_before: 50,
          limit_after: 50,
        }
      : "skip"
  );

  const initialData = useQuery(
    api.conversations.getAllMessages,
    !isTempId && !hasTarget && !initializedRef.current
      ? { conversation_id: conversationId as Id<"conversations">, limit: 100 }
      : "skip"
  );

  const olderMessagesData = useQuery(
    api.conversations.getAllMessages,
    !isTempId && loadOlderTimestamp !== undefined
      ? {
          conversation_id: conversationId as Id<"conversations">,
          limit: 50,
          before_timestamp: loadOlderTimestamp,
        }
      : "skip"
  );

  const jumpStartData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    !isTempId && jumpMode === "start"
      ? {
          conversation_id: conversationId as Id<"conversations">,
          center_timestamp: 0,
          limit_before: 0,
          limit_after: 100,
        }
      : "skip"
  );

  const jumpEndData = useQuery(
    api.conversations.getAllMessages,
    !isTempId && jumpMode === "end"
      ? { conversation_id: conversationId as Id<"conversations">, limit: 100 }
      : "skip"
  );

  const newerMessagesData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    !isTempId && loadNewerTimestamp !== undefined
      ? {
          conversation_id: conversationId as Id<"conversations">,
          center_timestamp: loadNewerTimestamp,
          limit_before: 0,
          limit_after: 50,
        }
      : "skip"
  );

  const newMessagesResult = useQuery(
    api.conversations.getNewMessages,
    !isTempId && lastTimestamp !== null && !hasMoreBelow
      ? {
          conversation_id: conversationId as Id<"conversations">,
          after_timestamp: lastTimestamp,
        }
      : "skip"
  );

  // Initialize from aroundData
  useEffect(() => {
    if (aroundData && !initializedRef.current) {
      const total = aroundData.message_count || aroundData.messages?.length || 0;
      const loaded = aroundData.messages?.length || 0;
      let startIdx = 0;
      if (!aroundData.has_more_above) {
        startIdx = 0;
      } else if (!aroundData.has_more_below) {
        startIdx = Math.max(0, total - loaded);
      } else {
        startIdx = Math.max(0, Math.round((total - loaded) / 2));
      }

      store.getState().setMessages(conversationId, aroundData.messages || [], {
        lastTimestamp: aroundData.last_timestamp,
        oldestTimestamp: aroundData.oldest_timestamp,
        hasMoreAbove: aroundData.has_more_above ?? false,
        hasMoreBelow: aroundData.has_more_below ?? false,
        loadedStartIndex: startIdx,
        isSearchingForTarget: false,
        initialized: true,
      });
      store.getState().setConversationMeta(conversationId, aroundData);
    }
  }, [aroundData, conversationId]);

  // Initialize from initialData
  useEffect(() => {
    if (initialData && !initializedRef.current) {
      const hasMessages = (initialData.messages?.length ?? 0) > 0;
      const shouldLock = hasMessages || initialData.status !== "active";
      const total = initialData.message_count || initialData.messages?.length || 0;
      const loaded = initialData.messages?.length || 0;

      store.getState().setMessages(conversationId, initialData.messages || [], {
        lastTimestamp: initialData.last_timestamp,
        oldestTimestamp: initialData.oldest_timestamp,
        hasMoreAbove: initialData.has_more_above ?? false,
        hasMoreBelow: false,
        loadedStartIndex: Math.max(0, total - loaded),
        initialized: shouldLock,
      });
      store.getState().setConversationMeta(conversationId, initialData);
    }
  }, [initialData, conversationId]);

  // Keep conversation metadata updated
  useEffect(() => {
    const latestData = aroundData || initialData;
    if (latestData && initializedRef.current) {
      const prev = store.getState().conversations[conversationId];
      if (
        prev &&
        prev.is_private === latestData.is_private &&
        prev.share_token === latestData.share_token &&
        prev.title === latestData.title &&
        prev.message_count === latestData.message_count
      ) return;
      store.getState().updateConversationMeta(conversationId, {
        is_private: latestData.is_private,
        share_token: latestData.share_token,
        title: latestData.title,
        message_count: latestData.message_count,
      });
    }
  }, [initialData, aroundData, conversationId]);

  // Handle older messages
  useEffect(() => {
    if (olderMessagesData && olderMessagesData.messages?.length > 0) {
      const s = store.getState();
      const existing = s.messages[conversationId] || [];
      const existingIds = new Set(existing.map((m: Message) => m._id));
      const uniqueOlder = olderMessagesData.messages.filter((m: Message) => !existingIds.has(m._id));

      store.getState().mergeMessages(conversationId, olderMessagesData.messages, "prepend", {
        oldestTimestamp: olderMessagesData.oldest_timestamp,
        hasMoreAbove: olderMessagesData.has_more_above ?? false,
        isLoadingOlder: false,
        loadOlderTimestamp: undefined,
        ...(!olderMessagesData.has_more_above ? { loadedStartIndex: 0 } : {
          loadedStartIndex: Math.max(0, (s.pagination[conversationId]?.loadedStartIndex ?? 0) - uniqueOlder.length),
        }),
      });
    } else if (olderMessagesData && olderMessagesData.messages?.length === 0) {
      store.getState().setPagination(conversationId, {
        hasMoreAbove: false,
        loadedStartIndex: 0,
        isLoadingOlder: false,
        loadOlderTimestamp: undefined,
      });
    }
  }, [olderMessagesData, conversationId]);

  // Handle jump to start
  useEffect(() => {
    if (jumpStartData && jumpMode === "start") {
      store.getState().setMessages(conversationId, jumpStartData.messages || [], {
        lastTimestamp: jumpStartData.last_timestamp,
        oldestTimestamp: jumpStartData.oldest_timestamp,
        hasMoreAbove: jumpStartData.has_more_above ?? false,
        hasMoreBelow: jumpStartData.has_more_below ?? false,
        loadedStartIndex: 0,
        loadOlderTimestamp: undefined,
        loadNewerTimestamp: undefined,
        isLoadingOlder: false,
        isLoadingNewer: false,
        jumpMode: null,
      });
    }
  }, [jumpStartData, jumpMode, conversationId]);

  // Handle jump to end
  useEffect(() => {
    if (jumpEndData && jumpMode === "end") {
      const total = jumpEndData.message_count || jumpEndData.messages?.length || 0;
      const loaded = jumpEndData.messages?.length || 0;
      store.getState().setMessages(conversationId, jumpEndData.messages || [], {
        lastTimestamp: jumpEndData.last_timestamp,
        oldestTimestamp: jumpEndData.oldest_timestamp,
        hasMoreAbove: jumpEndData.has_more_above ?? false,
        hasMoreBelow: false,
        loadedStartIndex: Math.max(0, total - loaded),
        loadOlderTimestamp: undefined,
        loadNewerTimestamp: undefined,
        isLoadingOlder: false,
        isLoadingNewer: false,
        jumpMode: null,
      });
    }
  }, [jumpEndData, jumpMode, conversationId]);

  // Handle newer messages loading
  useEffect(() => {
    if (newerMessagesData && newerMessagesData.messages?.length > 0) {
      store.getState().mergeMessages(conversationId, newerMessagesData.messages, "append", {
        ...(newerMessagesData.last_timestamp ? { lastTimestamp: newerMessagesData.last_timestamp } : {}),
        hasMoreBelow: newerMessagesData.has_more_below ?? false,
        isLoadingNewer: false,
        loadNewerTimestamp: undefined,
      });
    } else if (newerMessagesData && newerMessagesData.messages?.length === 0) {
      store.getState().setPagination(conversationId, {
        hasMoreBelow: false,
        isLoadingNewer: false,
        loadNewerTimestamp: undefined,
      });
    }
  }, [newerMessagesData, conversationId]);

  // Handle new messages polling
  useEffect(() => {
    if (newMessagesResult && newMessagesResult.messages?.length > 0) {
      const removeMatching = store.getState().removeMatchingOptimistic;
      for (const msg of newMessagesResult.messages) {
        if (msg.role === "user" && msg.content?.trim()) {
          removeMatching(conversationId, msg.content.replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").replace(/\[image\]/gi, "").trim() || msg.content);
        }
      }

      store.getState().mergeMessages(conversationId, newMessagesResult.messages, "append", {
        ...(newMessagesResult.last_timestamp !== null ? { lastTimestamp: newMessagesResult.last_timestamp } : {}),
        hasMoreBelow: false,
      });

      if (newMessagesResult.child_conversations?.length || newMessagesResult.child_conversation_map) {
        const prev = store.getState().conversations[conversationId];
        if (prev) {
          const existingIds = new Set((prev.child_conversations || []).map((c: any) => c._id));
          const newChildren = (newMessagesResult.child_conversations || []).filter((c: any) => !existingIds.has(c._id));
          store.getState().updateConversationMeta(conversationId, {
            child_conversations: [...(prev.child_conversations || []), ...newChildren],
            child_conversation_map: { ...(prev.child_conversation_map || {}), ...(newMessagesResult.child_conversation_map || {}) },
            agent_name_map: { ...(prev.agent_name_map || {}), ...(newMessagesResult.agent_name_map || {}) },
          });
        }
      }
    }
  }, [newMessagesResult, conversationId]);

  // Auto-search for target message
  useEffect(() => {
    if (!targetMessageId || !targetMessageTimestamp) return;
    const cached = store.getState().messages[conversationId] || [];
    if (cached.length === 0) return;
    const targetFound = cached.some((m) => m._id === targetMessageId);
    if (targetFound) {
      store.getState().setPagination(conversationId, { isSearchingForTarget: false });
      searchAttempts.current = 0;
      return;
    }
    const pag = store.getState().pagination[conversationId];
    if (
      pag?.hasMoreAbove &&
      !pag?.isLoadingOlder &&
      searchAttempts.current < MAX_SEARCH_ATTEMPTS &&
      pag?.oldestTimestamp !== null &&
      targetMessageTimestamp.timestamp < pag.oldestTimestamp!
    ) {
      store.getState().setPagination(conversationId, {
        isSearchingForTarget: true,
        isLoadingOlder: true,
        loadOlderTimestamp: pag.oldestTimestamp!,
      });
      searchAttempts.current += 1;
    } else if (!pag?.hasMoreAbove || searchAttempts.current >= MAX_SEARCH_ATTEMPTS) {
      store.getState().setPagination(conversationId, { isSearchingForTarget: false });
    }
  }, [targetMessageId, targetMessageTimestamp, conversationId, hasMoreAbove, isLoadingOlder, oldestTimestamp]);

  // Auto-search for highlight message
  useEffect(() => {
    if (!highlightMessageResult) return;
    const cached = store.getState().messages[conversationId] || [];
    if (cached.length === 0) return;
    const highlightFound = cached.some((m) => m._id === highlightMessageResult.message_id);
    if (highlightFound) {
      store.getState().setPagination(conversationId, { isSearchingForTarget: false });
      highlightSearchAttempts.current = 0;
      return;
    }
    const pag = store.getState().pagination[conversationId];
    if (
      pag?.hasMoreAbove &&
      !pag?.isLoadingOlder &&
      highlightSearchAttempts.current < MAX_SEARCH_ATTEMPTS &&
      pag?.oldestTimestamp !== null &&
      highlightMessageResult.timestamp < pag.oldestTimestamp!
    ) {
      store.getState().setPagination(conversationId, {
        isSearchingForTarget: true,
        isLoadingOlder: true,
        loadOlderTimestamp: pag.oldestTimestamp!,
      });
      highlightSearchAttempts.current += 1;
    } else if (!pag?.hasMoreAbove || highlightSearchAttempts.current >= MAX_SEARCH_ATTEMPTS) {
      store.getState().setPagination(conversationId, { isSearchingForTarget: false });
    }
  }, [highlightMessageResult, conversationId, hasMoreAbove, isLoadingOlder, oldestTimestamp]);

  // Action callbacks
  const loadOlder = useCallback(() => {
    const p = store.getState().pagination[conversationId];
    if (p?.oldestTimestamp !== null && p?.hasMoreAbove && !p?.isLoadingOlder) {
      store.getState().setPagination(conversationId, {
        isLoadingOlder: true,
        loadOlderTimestamp: p.oldestTimestamp!,
      });
    }
  }, [conversationId]);

  const loadNewer = useCallback(() => {
    const p = store.getState().pagination[conversationId];
    if (p?.lastTimestamp !== null && p?.hasMoreBelow && !p?.isLoadingNewer) {
      store.getState().setPagination(conversationId, {
        isLoadingNewer: true,
        loadNewerTimestamp: p.lastTimestamp!,
      });
    }
  }, [conversationId]);

  const jumpToStart = useCallback(() => {
    store.getState().setPagination(conversationId, {
      jumpMode: "start",
      isLoadingOlder: true,
    });
  }, [conversationId]);

  const jumpToEnd = useCallback(() => {
    store.getState().setPagination(conversationId, {
      jumpMode: "end",
      isLoadingNewer: true,
    });
  }, [conversationId]);

  const isLoading = hasTarget
    ? !targetTimestampReady || (aroundData === undefined && !store.getState().conversations[conversationId])
    : initialData === undefined && !store.getState().conversations[conversationId];

  const targetMessageFound = targetMessageId
    ? (store.getState().messages[conversationId] || []).some((m) => m._id === targetMessageId)
    : true;

  return {
    isLoading,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    targetMessageFound,
  };
}
