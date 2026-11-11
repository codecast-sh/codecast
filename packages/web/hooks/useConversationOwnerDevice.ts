import { useInboxStore } from "../store/inboxStore";

/**
 * The machine whose daemon carries a conversation's messages. The inbox row
 * holds it for sessions in the inbox window; a conversation opened by link
 * (an older or hidden session) has only its conversation row.
 */
export function useConversationOwnerDevice(conversationId: string | null | undefined): string | undefined {
  return useInboxStore((s) =>
    conversationId
      ? ((s.sessions[conversationId]?.owner_device_id ?? s.conversations[conversationId]?.owner_device_id) as string | undefined)
      : undefined,
  );
}
