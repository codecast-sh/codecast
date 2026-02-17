import { create } from "zustand";

interface OptimisticMessage {
  _id: string;
  role: "user";
  content: string;
  timestamp: number;
  _isOptimistic?: true;
}

interface OptimisticMessagesStore {
  messages: Record<string, OptimisticMessage[]>;
  add: (conversationId: string, content: string) => string;
  remove: (conversationId: string, messageId: string) => void;
  removeMatching: (conversationId: string, content: string) => void;
}

export const useOptimisticMessagesStore = create<OptimisticMessagesStore>((set, get) => ({
  messages: {},
  add: (conversationId, content) => {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg: OptimisticMessage = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] || []), msg],
      },
    }));
    return id;
  },
  remove: (conversationId, messageId) => {
    set((s) => {
      const current = s.messages[conversationId];
      if (!current) return s;
      return {
        messages: {
          ...s.messages,
          [conversationId]: current.filter((m) => m._id !== messageId),
        },
      };
    });
  },
  removeMatching: (conversationId, content) => {
    set((s) => {
      const current = s.messages[conversationId];
      if (!current) return s;
      const trimmed = content.trim();
      let removed = false;
      const filtered = current.filter((m) => {
        if (!removed && m.content.trim() === trimmed) {
          removed = true;
          return false;
        }
        return true;
      });
      if (!removed) return s;
      return {
        messages: { ...s.messages, [conversationId]: filtered },
      };
    });
  },
}));
