import { useCallback, useEffect, useState, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

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
};

export function useConversationMessages(
  conversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
) {
  const [lastTimestamp, setLastTimestamp] = useState<number | null>(null);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [cachedMessages, setCachedMessages] = useState<Message[]>([]);
  const [cachedConversation, setCachedConversation] = useState<any>(null);
  const [hasMoreAbove, setHasMoreAbove] = useState(false);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const [loadedStartIndex, setLoadedStartIndex] = useState(0);
  const [loadOlderTimestamp, setLoadOlderTimestamp] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const [loadNewerTimestamp, setLoadNewerTimestamp] = useState<number | undefined>(undefined);
  const [isSearchingForTarget, setIsSearchingForTarget] = useState(false);
  const [jumpMode, setJumpMode] = useState<'start' | 'end' | null>(null);
  const searchAttempts = useRef(0);
  const maxSearchAttempts = 20;
  const initializedRef = useRef(false);

  // Query for target message timestamp if we have a target
  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    targetMessageId
      ? {
          conversation_id: conversationId as Id<"conversations">,
          message_id: targetMessageId as Id<"messages">,
        }
      : "skip"
  );

  // Query for highlight search result
  const cleanedHighlightQuery = highlightQuery?.replace(/^"|"$/g, "").trim();
  const highlightMessageResult = useQuery(
    api.messages.findMessageByContent,
    cleanedHighlightQuery
      ? {
          conversation_id: conversationId as Id<"conversations">,
          search_term: cleanedHighlightQuery,
        }
      : "skip"
  );

  const effectiveTargetTimestamp = targetMessageTimestamp?.timestamp ?? highlightMessageResult?.timestamp;
  const hasTarget = !!(targetMessageId || cleanedHighlightQuery);
  const targetTimestampReady = hasTarget && effectiveTargetTimestamp !== undefined;

  // When we have a target with timestamp, use aroundData to load messages centered on it
  const aroundData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    targetTimestampReady && !initializedRef.current
      ? {
          conversation_id: conversationId as Id<"conversations">,
          center_timestamp: effectiveTargetTimestamp!,
          limit_before: 50,
          limit_after: 50,
        }
      : "skip"
  );

  // When there's no target, or target timestamp is still loading, use initialData
  // But don't use initialData if we have a target and are waiting for timestamp
  const initialData = useQuery(
    api.conversations.getAllMessages,
    !hasTarget && !initializedRef.current
      ? { conversation_id: conversationId as Id<"conversations">, limit: 100 }
      : "skip"
  );

  // Pagination queries
  const olderMessagesData = useQuery(
    api.conversations.getAllMessages,
    loadOlderTimestamp !== undefined
      ? {
          conversation_id: conversationId as Id<"conversations">,
          limit: 50,
          before_timestamp: loadOlderTimestamp,
        }
      : "skip"
  );

  const jumpStartData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    jumpMode === 'start'
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
    jumpMode === 'end'
      ? { conversation_id: conversationId as Id<"conversations">, limit: 100 }
      : "skip"
  );

  const newerMessagesData = useQuery(
    api.conversations.getMessagesAroundTimestamp,
    loadNewerTimestamp !== undefined
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
    lastTimestamp !== null && !hasMoreBelow
      ? {
          conversation_id: conversationId as Id<"conversations">,
          after_timestamp: lastTimestamp,
        }
      : "skip"
  );

  // Initialize from aroundData when it loads
  useEffect(() => {
    if (aroundData && !initializedRef.current) {
      initializedRef.current = true;
      setCachedConversation(aroundData);
      setCachedMessages(aroundData.messages || []);
      setLastTimestamp(aroundData.last_timestamp);
      setOldestTimestamp(aroundData.oldest_timestamp);
      setHasMoreAbove(aroundData.has_more_above ?? false);
      setHasMoreBelow(aroundData.has_more_below ?? false);
      setIsSearchingForTarget(false);
      const total = aroundData.message_count || aroundData.messages?.length || 0;
      const loaded = aroundData.messages?.length || 0;
      if (!aroundData.has_more_above) {
        setLoadedStartIndex(0);
      } else if (!aroundData.has_more_below) {
        setLoadedStartIndex(Math.max(0, total - loaded));
      } else {
        setLoadedStartIndex(Math.max(0, Math.round((total - loaded) / 2)));
      }
    }
  }, [aroundData]);

  // Initialize from initialData when it loads (no target case)
  useEffect(() => {
    if (initialData && !initializedRef.current) {
      initializedRef.current = true;
      setCachedConversation(initialData);
      setCachedMessages(initialData.messages || []);
      setLastTimestamp(initialData.last_timestamp);
      setOldestTimestamp(initialData.oldest_timestamp);
      setHasMoreAbove(initialData.has_more_above ?? false);
      setHasMoreBelow(false);
      const total = initialData.message_count || initialData.messages?.length || 0;
      const loaded = initialData.messages?.length || 0;
      setLoadedStartIndex(Math.max(0, total - loaded));
    }
  }, [initialData]);

  // Keep conversation metadata updated
  useEffect(() => {
    const latestData = aroundData || initialData;
    if (latestData && initializedRef.current && cachedConversation) {
      setCachedConversation((prev: any) => ({
        ...prev,
        is_private: latestData.is_private,
        share_token: latestData.share_token,
        title: latestData.title,
      }));
    }
  }, [initialData, aroundData, cachedConversation]);

  // Handle older messages loading
  useEffect(() => {
    if (olderMessagesData && olderMessagesData.messages?.length > 0) {
      const existingIds = new Set(cachedMessages.map((m) => m._id));
      const uniqueOlder = olderMessagesData.messages.filter(
        (m: Message) => !existingIds.has(m._id)
      );
      if (uniqueOlder.length > 0) {
        setCachedMessages((prev) => {
          const ids = new Set(prev.map((m) => m._id));
          const fresh = olderMessagesData.messages.filter((m: Message) => !ids.has(m._id));
          if (fresh.length === 0) return prev;
          return [...fresh, ...prev].sort((a, b) => a.timestamp - b.timestamp);
        });
        setLoadedStartIndex((idx) => Math.max(0, idx - uniqueOlder.length));
      }
      setOldestTimestamp(olderMessagesData.oldest_timestamp);
      setHasMoreAbove(olderMessagesData.has_more_above ?? false);
      if (!olderMessagesData.has_more_above) {
        setLoadedStartIndex(0);
      }
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    } else if (olderMessagesData && olderMessagesData.messages?.length === 0) {
      setHasMoreAbove(false);
      setLoadedStartIndex(0);
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    }
  }, [olderMessagesData]);

  // Handle jump to start
  useEffect(() => {
    if (jumpStartData && jumpMode === 'start') {
      setCachedMessages(jumpStartData.messages || []);
      setLastTimestamp(jumpStartData.last_timestamp);
      setOldestTimestamp(jumpStartData.oldest_timestamp);
      setHasMoreAbove(jumpStartData.has_more_above ?? false);
      setHasMoreBelow(jumpStartData.has_more_below ?? false);
      setLoadedStartIndex(0);
      setLoadOlderTimestamp(undefined);
      setLoadNewerTimestamp(undefined);
      setIsLoadingOlder(false);
      setIsLoadingNewer(false);
      setJumpMode(null);
    }
  }, [jumpStartData, jumpMode]);

  // Handle jump to end
  useEffect(() => {
    if (jumpEndData && jumpMode === 'end') {
      setCachedMessages(jumpEndData.messages || []);
      setLastTimestamp(jumpEndData.last_timestamp);
      setOldestTimestamp(jumpEndData.oldest_timestamp);
      setHasMoreAbove(jumpEndData.has_more_above ?? false);
      setHasMoreBelow(false);
      const total = jumpEndData.message_count || jumpEndData.messages?.length || 0;
      const loaded = jumpEndData.messages?.length || 0;
      setLoadedStartIndex(Math.max(0, total - loaded));
      setLoadOlderTimestamp(undefined);
      setLoadNewerTimestamp(undefined);
      setIsLoadingOlder(false);
      setIsLoadingNewer(false);
      setJumpMode(null);
    }
  }, [jumpEndData, jumpMode]);

  // Handle newer messages loading (forward pagination)
  useEffect(() => {
    if (newerMessagesData && newerMessagesData.messages?.length > 0) {
      setCachedMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m._id));
        const uniqueNewer = newerMessagesData.messages.filter(
          (m: Message) => !existingIds.has(m._id)
        );
        if (uniqueNewer.length === 0) return prev;
        return [...prev, ...uniqueNewer].sort((a, b) => a.timestamp - b.timestamp);
      });
      if (newerMessagesData.last_timestamp) {
        setLastTimestamp(newerMessagesData.last_timestamp);
      }
      setHasMoreBelow(newerMessagesData.has_more_below ?? false);
      setIsLoadingNewer(false);
      setLoadNewerTimestamp(undefined);
    } else if (newerMessagesData && newerMessagesData.messages?.length === 0) {
      setHasMoreBelow(false);
      setIsLoadingNewer(false);
      setLoadNewerTimestamp(undefined);
    }
  }, [newerMessagesData]);

  // Handle new messages polling
  useEffect(() => {
    if (newMessagesResult && newMessagesResult.messages?.length > 0) {
      setCachedMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m._id));
        const uniqueNew = newMessagesResult.messages.filter(
          (m: Message) => !existingIds.has(m._id)
        );
        if (uniqueNew.length === 0) return prev;
        return [...prev, ...uniqueNew].sort((a, b) => a.timestamp - b.timestamp);
      });

      if (newMessagesResult.last_timestamp !== null) {
        setLastTimestamp(newMessagesResult.last_timestamp);
      }
      setHasMoreBelow(false);

      if (newMessagesResult.child_conversations?.length || newMessagesResult.child_conversation_map) {
        setCachedConversation((prev: any) => {
          if (!prev) return prev;
          const existingIds = new Set((prev.child_conversations || []).map((c: any) => c._id));
          const newChildren = (newMessagesResult.child_conversations || []).filter((c: any) => !existingIds.has(c._id));
          return {
            ...prev,
            child_conversations: [...(prev.child_conversations || []), ...newChildren],
            child_conversation_map: { ...(prev.child_conversation_map || {}), ...(newMessagesResult.child_conversation_map || {}) },
          };
        });
      }
    }
  }, [newMessagesResult]);

  // Auto-search for target message if not found in initial load
  useEffect(() => {
    if (!targetMessageId || !cachedMessages.length || !targetMessageTimestamp) {
      return;
    }

    const targetFound = cachedMessages.some((m) => m._id === targetMessageId);

    if (targetFound) {
      setIsSearchingForTarget(false);
      searchAttempts.current = 0;
      return;
    }

    if (
      hasMoreAbove &&
      !isLoadingOlder &&
      searchAttempts.current < maxSearchAttempts &&
      oldestTimestamp !== null &&
      targetMessageTimestamp.timestamp < oldestTimestamp
    ) {
      setIsSearchingForTarget(true);
      searchAttempts.current += 1;
      setIsLoadingOlder(true);
      setLoadOlderTimestamp(oldestTimestamp);
    } else if (!hasMoreAbove || searchAttempts.current >= maxSearchAttempts) {
      setIsSearchingForTarget(false);
    }
  }, [
    targetMessageId,
    cachedMessages,
    hasMoreAbove,
    isLoadingOlder,
    oldestTimestamp,
    targetMessageTimestamp,
  ]);

  // Auto-search for highlight message if not found
  const highlightSearchAttempts = useRef(0);
  useEffect(() => {
    if (!highlightMessageResult || !cachedMessages.length) {
      return;
    }

    const highlightFound = cachedMessages.some(
      (m) => m._id === highlightMessageResult.message_id
    );

    if (highlightFound) {
      setIsSearchingForTarget(false);
      highlightSearchAttempts.current = 0;
      return;
    }

    if (
      hasMoreAbove &&
      !isLoadingOlder &&
      highlightSearchAttempts.current < maxSearchAttempts &&
      oldestTimestamp !== null &&
      highlightMessageResult.timestamp < oldestTimestamp
    ) {
      setIsSearchingForTarget(true);
      highlightSearchAttempts.current += 1;
      setIsLoadingOlder(true);
      setLoadOlderTimestamp(oldestTimestamp);
    } else if (!hasMoreAbove || highlightSearchAttempts.current >= maxSearchAttempts) {
      setIsSearchingForTarget(false);
    }
  }, [
    highlightMessageResult,
    cachedMessages,
    hasMoreAbove,
    isLoadingOlder,
    oldestTimestamp,
  ]);

  const loadOlder = useCallback(() => {
    if (oldestTimestamp !== null && hasMoreAbove && !isLoadingOlder) {
      setIsLoadingOlder(true);
      setLoadOlderTimestamp(oldestTimestamp);
    }
  }, [oldestTimestamp, hasMoreAbove, isLoadingOlder]);

  const loadNewer = useCallback(() => {
    if (lastTimestamp !== null && hasMoreBelow && !isLoadingNewer) {
      setIsLoadingNewer(true);
      setLoadNewerTimestamp(lastTimestamp);
    }
  }, [lastTimestamp, hasMoreBelow, isLoadingNewer]);

  const jumpToStart = useCallback(() => {
    setJumpMode('start');
    setIsLoadingOlder(true);
  }, []);

  const jumpToEnd = useCallback(() => {
    setJumpMode('end');
    setIsLoadingNewer(true);
  }, []);

  const conversation = cachedConversation
    ? {
        ...cachedConversation,
        messages: cachedMessages,
        loaded_start_index: loadedStartIndex,
      }
    : null;

  const targetMessageFound = targetMessageId
    ? cachedMessages.some((m) => m._id === targetMessageId)
    : true;

  // Determine loading state:
  // - If we have a target, wait for the timestamp query AND the aroundData
  // - If no target, wait for initialData
  const isLoading = hasTarget
    ? !targetTimestampReady || (aroundData === undefined && !cachedConversation)
    : initialData === undefined && !cachedConversation;

  return {
    conversation: isLoading ? undefined : conversation,
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
