import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { createReducer, reducer } from "../lib/messageReducer";

export function useProcessedMessages(conversationId: Id<"conversations">) {
  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: conversationId,
  });

  const [state] = useState(() => createReducer());

  const processed = useMemo(() => {
    if (!conversation?.messages) return [];
    return reducer(state, conversation.messages);
  }, [conversation?.messages, state]);

  return {
    messages: processed,
    todos: state.latestTodos,
    usage: state.latestUsage,
    isLoading: conversation === undefined,
    conversation,
  };
}
