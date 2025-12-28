import { useCallback, useEffect, useState } from "react";
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
  model?: string;
  started_at?: number;
  share_token?: string;
  is_private?: boolean;
  message_count?: number;
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
};

export function useConversationMessages(conversationId: string) {
  const [lastTimestamp, setLastTimestamp] = useState<number | null>(null);
  const [cachedMessages, setCachedMessages] = useState<Message[]>([]);
  const [cachedConversation, setCachedConversation] = useState<any>(null);

  const initialData = useQuery(
    api.conversations.getAllMessages,
    { conversation_id: conversationId as Id<"conversations"> }
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

  const conversation = cachedConversation
    ? {
        ...cachedConversation,
        messages: cachedMessages,
      }
    : null;

  return {
    conversation: initialData === undefined ? undefined : conversation,
    hasMoreAbove: false,
    isLoadingOlder: false,
    loadOlder: useCallback(() => {}, []),
  };
}
