import { useMemo } from "react";
import { isStickyEligible, pickStickyFallbackFromLoaded, stickyPromptContent, mergeNavigatorSources, buildNavigatorRows } from "../lib/messageNavigator";
import { isStickyWorthy } from "../components/conversation/classify";
import type { Message, TimelineItem, UserMessageKind } from "../components/conversation/types";
import type { UserMessage } from "../store/inboxStore";

export function useNavigatorIndex({ cachedUserMessages, messages, timeline, userMsgKindMap, hasMoreAbove }: {
  cachedUserMessages: UserMessage[] | undefined;
  messages: Message[];
  timeline: TimelineItem[];
  userMsgKindMap: Map<string, UserMessageKind>;
  hasMoreAbove: boolean | undefined;
}) {
  // Full navigable-message list from the store cache (populated once by
  // useConversationMessages), unioned with the loaded transcript window.
  // The cache is newest-first capped, so a long thread's opening prompts can
  // be missing from it while still sitting on screen — those loaded rows have
  // to join the navigator or the highlighted #1 is a later prompt.
  const serverUserMessages = cachedUserMessages;
  const navigatorSources = useMemo(
    () => mergeNavigatorSources(serverUserMessages, messages),
    [serverUserMessages, messages],
  );

  const processedServerMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of navigatorSources) {
      if (isStickyEligible(m.content ?? "")) ids.add(m._id);
    }
    return ids;
  }, [navigatorSources]);

  const navigatorIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const row of buildNavigatorRows(navigatorSources)) ids.add(row._id);
    return ids;
  }, [navigatorSources]);

  const stickyUserMsgIndices = useMemo(() => {
    const useServer = processedServerMsgIds.size > 0;
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      if (useServer) {
        if (processedServerMsgIds.has(msg._id)) indices.push(i);
      } else {
        const kind = userMsgKindMap.get(msg._id);
        if (kind && isStickyWorthy(kind) && stickyPromptContent(msg.content) !== null) indices.push(i);
      }
    }
    return indices;
  }, [timeline, processedServerMsgIds, userMsgKindMap]);

  const navigatorTimelineIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      if (navigatorIdSet.has((item.data as Message)._id)) indices.push(i);
    }
    return indices;
  }, [timeline, navigatorIdSet]);

  const timelineMessageIds = useMemo(
    () => timeline.map((item) => (item.type === "message" ? (item.data as Message)._id : null)),
    [timeline],
  );

  const serverStickyFallback = useMemo(() => {
    if (!hasMoreAbove) return null;
    const loaded: Message[] = [];
    for (const item of timeline) {
      if (item.type === 'message') loaded.push(item.data as Message);
    }
    return pickStickyFallbackFromLoaded(serverUserMessages, loaded);
  }, [serverUserMessages, timeline, hasMoreAbove]);

  return { serverUserMessages, stickyUserMsgIndices, navigatorTimelineIndices, timelineMessageIds, serverStickyFallback };
}
