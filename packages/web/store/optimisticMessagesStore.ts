import { create } from "zustand";

interface OptimisticMessage {
  _id: string;
  role: "user";
  content: string;
  timestamp: number;
  _isOptimistic?: true;
  images?: Array<{ media_type: string; storage_id?: string }>;
}

interface OptimisticMessagesStore {
  messages: Record<string, OptimisticMessage[]>;
  add: (conversationId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => string;
  remove: (conversationId: string, messageId: string) => void;
  removeMatching: (conversationId: string, content: string) => void;
}

export const useOptimisticMessagesStore = create<OptimisticMessagesStore>((set, get) => ({
  messages: {},
  add: (conversationId, content, images) => {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg: OptimisticMessage = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      ...(images && images.length > 0 ? { images } : {}),
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
      const normalize = (s: string) => s.replace(/\[image\]/gi, "").trim();
      const trimmed = normalize(content);
      let removed = false;
      const filtered = current.filter((m) => {
        if (!removed && normalize(m.content) === trimmed) {
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
