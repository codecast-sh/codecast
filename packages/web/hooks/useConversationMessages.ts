import { useCallback, useEffect, useRef, useState } from "react";
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

type ConversationData = {
  _id: string;
  title?: string;
  session_id?: string;
  agent_type?: string;
  share_token?: string;
  is_private?: boolean;
  messages: Message[];
  user?: { name?: string; email?: string } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_diff?: string | null;
  git_diff_staged?: string | null;
  git_remote_url?: string | null;
  has_more_above?: boolean;
  oldest_timestamp?: number | null;
};

export function useConversationMessages(conversationId: string) {
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [hasMoreAbove, setHasMoreAbove] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadingRef = useRef(false);

  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: conversationId as Id<"conversations">,
  }) as ConversationData | null | undefined;

  const olderMessagesResult = useQuery(
    api.conversations.getOlderMessages,
    oldestTimestamp !== null && hasMoreAbove && isLoadingOlder
      ? {
          conversation_id: conversationId as Id<"conversations">,
          before_timestamp: oldestTimestamp,
          limit: 100,
        }
      : "skip"
  );

  // Initialize from conversation
  useEffect(() => {
    if (conversation) {
      setHasMoreAbove(conversation.has_more_above ?? false);
      if (conversation.oldest_timestamp !== undefined) {
        setOldestTimestamp(conversation.oldest_timestamp);
      }
    }
  }, [conversation]);

  // Handle older messages result
  useEffect(() => {
    if (olderMessagesResult && isLoadingOlder) {
      setOlderMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m._id));
        const newMsgs = olderMessagesResult.messages.filter(
          (m: Message) => !existingIds.has(m._id)
        );
        return [...newMsgs, ...prev];
      });
      setHasMoreAbove(olderMessagesResult.has_more);
      if (olderMessagesResult.oldest_timestamp !== null) {
        setOldestTimestamp(olderMessagesResult.oldest_timestamp);
      }
      setIsLoadingOlder(false);
      loadingRef.current = false;
    }
  }, [olderMessagesResult, isLoadingOlder]);

  // Reset when conversation changes
  useEffect(() => {
    setOlderMessages([]);
    setOldestTimestamp(null);
    setHasMoreAbove(false);
    setIsLoadingOlder(false);
    loadingRef.current = false;
  }, [conversationId]);

  const loadOlder = useCallback(() => {
    if (loadingRef.current || !hasMoreAbove || oldestTimestamp === null) return;
    loadingRef.current = true;
    setIsLoadingOlder(true);
  }, [hasMoreAbove, oldestTimestamp]);

  // Combine messages: older loaded messages + current conversation messages
  const allMessages = conversation
    ? (() => {
        const currentMsgs = conversation.messages || [];
        const currentIds = new Set(currentMsgs.map((m) => m._id));
        const uniqueOlder = olderMessages.filter((m) => !currentIds.has(m._id));
        return [...uniqueOlder, ...currentMsgs].sort(
          (a, b) => a.timestamp - b.timestamp
        );
      })()
    : [];

  return {
    conversation: conversation
      ? { ...conversation, messages: allMessages }
      : conversation,
    hasMoreAbove,
    isLoadingOlder,
    loadOlder,
  };
}
