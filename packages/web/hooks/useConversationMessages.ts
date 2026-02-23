import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncConversationMessages } from "./useSyncConversationMessages";

export function useConversationMessages(
  conversationId: string,
  targetMessageId?: string,
  highlightQuery?: string
) {
  const {
    isLoading,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    targetMessageFound,
  } = useSyncConversationMessages(conversationId, targetMessageId, highlightQuery);

  const msgs = useInboxStore((s) => s.messages[conversationId]);
  const optimistic = useInboxStore((s) => s.optimisticMessages[conversationId]);
  const conversationMeta = useInboxStore((s) => s.conversations[conversationId]);
  const pag = useInboxStore((s) => s.pagination[conversationId]);

  const mergedMessages = useMemo(
    () => useInboxStore.getState().getMergedMessages(conversationId),
    [conversationId, msgs, optimistic]
  );

  const hasMoreAbove = pag?.hasMoreAbove ?? false;
  const hasMoreBelow = pag?.hasMoreBelow ?? false;
  const isLoadingOlder = pag?.isLoadingOlder ?? false;
  const isLoadingNewer = pag?.isLoadingNewer ?? false;
  const isSearchingForTarget = pag?.isSearchingForTarget ?? false;
  const loadedStartIndex = pag?.loadedStartIndex ?? 0;

  const conversation: any = conversationMeta
    ? {
        ...conversationMeta,
        messages: mergedMessages,
        loaded_start_index: loadedStartIndex,
      }
    : null;

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
