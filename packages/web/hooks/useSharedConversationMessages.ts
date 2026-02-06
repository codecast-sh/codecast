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

export function useSharedConversationMessages(conversationId: string, highlightQuery?: string) {
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [cachedMessages, setCachedMessages] = useState<Message[]>([]);
  const [cachedConversation, setCachedConversation] = useState<any>(null);
  const [hasMoreAbove, setHasMoreAbove] = useState(false);
  const [loadOlderTimestamp, setLoadOlderTimestamp] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [accessLevel, setAccessLevel] = useState<string | null>(null);
  const [isSearchingForTarget, setIsSearchingForTarget] = useState(false);
  const [jumpMode, setJumpMode] = useState<'start' | null>(null);
  const highlightSearchAttempts = useRef(0);
  const maxSearchAttempts = 20;

  const initialData = useQuery(
    api.conversations.getConversationPublic,
    { conversation_id: conversationId as Id<"conversations">, limit: 100 }
  );

  const cleanedHighlightQuery = highlightQuery?.replace(/^"|"$/g, "").trim();
  const highlightMessageResult = useQuery(
    api.messages.findMessageByContentPublic,
    cleanedHighlightQuery
      ? {
          conversation_id: conversationId as Id<"conversations">,
          search_term: cleanedHighlightQuery,
        }
      : "skip"
  );

  const olderMessagesData = useQuery(
    api.conversations.getConversationPublic,
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

  useEffect(() => {
    if (initialData && initialData.conversation) {
      setAccessLevel(initialData.access_level);
      setCachedConversation((prev: any) => {
        if (!prev) {
          setCachedMessages(initialData.conversation.messages || []);
          setOldestTimestamp(initialData.conversation.oldest_timestamp);
          setHasMoreAbove(initialData.conversation.has_more_above ?? false);
          return initialData.conversation;
        }
        return {
          ...prev,
          is_private: initialData.conversation.is_private,
          share_token: initialData.conversation.share_token,
          title: initialData.conversation.title,
        };
      });
    } else if (initialData) {
      setAccessLevel(initialData.access_level);
    }
  }, [initialData]);

  useEffect(() => {
    const conv = olderMessagesData?.conversation;
    const messages = conv?.messages;
    if (conv && messages && messages.length > 0) {
      setCachedMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m._id));
        const uniqueOlder = messages.filter(
          (m: Message) => !existingIds.has(m._id)
        );
        if (uniqueOlder.length === 0) return prev;
        return [...uniqueOlder, ...prev].sort((a, b) => a.timestamp - b.timestamp);
      });
      setOldestTimestamp(conv.oldest_timestamp);
      setHasMoreAbove(conv.has_more_above ?? false);
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    } else if (olderMessagesData && (!messages || messages.length === 0)) {
      setHasMoreAbove(false);
      setIsLoadingOlder(false);
      setLoadOlderTimestamp(undefined);
    }
  }, [olderMessagesData]);

  // Handle jump to start
  useEffect(() => {
    if (jumpStartData && jumpMode === 'start') {
      setCachedMessages(jumpStartData.messages || []);
      setOldestTimestamp(jumpStartData.oldest_timestamp);
      setHasMoreAbove(jumpStartData.has_more_above ?? false);
      setLoadOlderTimestamp(undefined);
      setIsLoadingOlder(false);
      setJumpMode(null);
    }
  }, [jumpStartData, jumpMode]);

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

  const jumpToStart = useCallback(() => {
    setJumpMode('start');
  }, []);

  const conversation = cachedConversation
    ? {
        ...cachedConversation,
        messages: cachedMessages,
      }
    : null;

  return {
    conversation: initialData === undefined ? undefined : conversation,
    accessLevel,
    hasMoreAbove,
    isLoadingOlder,
    loadOlder,
    jumpToStart,
    isSearchingForTarget,
  };
}
