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
  const [loadOlderTimestamp, setLoadOlderTimestamp] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isSearchingForTarget, setIsSearchingForTarget] = useState(false);
  const searchAttempts = useRef(0);
  const maxSearchAttempts = 20;

  const initialData = useQuery(
    api.conversations.getAllMessages,
    { conversation_id: conversationId as Id<"conversations">, limit: 100 }
  );

  const targetMessageTimestamp = useQuery(
    api.messages.getMessageTimestamp,
    targetMessageId
      ? {
          conversation_id: conversationId as Id<"conversations">,
          message_id: targetMessageId as Id<"messages">,
        }
      : "skip"
  );

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

  const newMessagesResult = useQuery(
    api.conversations.getNewMessages,
    lastTimestamp !== null
      ? {
          conversation_id: conversationId as Id<"conversations">,
          after_timestamp: lastTimestamp,
        }
      : "skip"
  );

  useEffect(() => {
    if (initialData) {
      setCachedConversation((prev: any) => {
        if (!prev) {
          setCachedMessages(initialData.messages || []);
          setLastTimestamp(initialData.last_timestamp);
          setOldestTimestamp(initialData.oldest_timestamp);
          setHasMoreAbove(initialData.has_more_above ?? false);
          return initialData;
        }
        return {
          ...prev,
          is_private: initialData.is_private,
          share_token: initialData.share_token,
          title: initialData.title,
        };
      });
    }
  }, [initialData]);

  useEffect(() => {
    if (olderMessagesData && olderMessagesData.messages?.length > 0) {
      setCachedMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m._id));
        const uniqueOlder = olderMessagesData.messages.filter(
          (m: Message) => !existingIds.has(m._id)
        );
        if (uniqueOlder.length === 0) return prev;
        return [...uniqueOlder, ...prev].sort((a, b) => a.timestamp - b.timestamp);
      });
      setOldestTimestamp(olderMessagesData.oldest_timestamp);
      setHasMoreAbove(olderMessagesData.has_more_above ?? false);
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    } else if (olderMessagesData && olderMessagesData.messages?.length === 0) {
      setHasMoreAbove(false);
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    }
  }, [olderMessagesData]);

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
    }
  }, [newMessagesResult]);

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

  const conversation = cachedConversation
    ? {
        ...cachedConversation,
        messages: cachedMessages,
      }
    : null;

  const targetMessageFound = targetMessageId
    ? cachedMessages.some((m) => m._id === targetMessageId)
    : true;

  return {
    conversation: initialData === undefined ? undefined : conversation,
    hasMoreAbove,
    isLoadingOlder,
    loadOlder,
    isSearchingForTarget,
    targetMessageFound,
  };
}
