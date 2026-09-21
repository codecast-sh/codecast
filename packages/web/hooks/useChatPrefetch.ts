import { useRef } from "react";
import { useConvex, useConvexConnectionState } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type ChatRailRow } from "../store/inboxStore";
import { createChatPrefetcher } from "../lib/chatPrefetch";
import { ingestChatPage } from "../lib/ingestChatPage";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export function useChatPrefetch(data: { team_id?: string; rail?: ChatRailRow[] } | undefined, enabled: boolean) {
  const convex = useConvex();
  const viewerId = useInboxStore(s => s.currentUser?._id);
  const teamId = useInboxStore(s => s.clientState.ui?.active_team_id);
  const { isWebSocketConnected } = useConvexConnectionState();
  const ready = enabled && isWebSocketConnected && !!viewerId && !!teamId;
  const { data: notifications } = useQueryNoThrow(api.notifications.list, ready ? {} : "skip");
  const worker = useRef<ReturnType<typeof createChatPrefetcher> | null>(null);
  const visibleChannels = useRef(new Set<string>());
  visibleChannels.current = new Set(data && data.team_id === teamId ? (data.rail ?? []).map(row => row.channel_id) : []);

  useWatchEffect(() => {
    if (!ready) return;
    const current = createChatPrefetcher({
      load: target => {
        if (target.kind === "channel") return convex.query(api.chat.listMessages, { channel_id: target.id as any, limit: 50 });
        if (target.kind === "thread") return convex.query(api.chat.getThread, { root_id: target.id as any });
        return convex.query(api.chat.getMessage, { message_id: target.id as any });
      },
      ingest: ingestChatPage,
      read: id => useInboxStore.getState().chatMessages[id],
      allowed: channelId => {
        const state = useInboxStore.getState();
        return state.currentUser?._id === viewerId && state.clientState.ui?.active_team_id === teamId
          && state.syncRole !== "follower" && visibleChannels.current.has(channelId) && !!state.chatChannels[channelId];
      },
      onError: error => captureException(error, { tags: { operation: "chat-prefetch" } }),
    });
    worker.current = current;
    return () => { current.dispose(); worker.current = null; };
  }, [convex, viewerId, teamId, ready]);

  useWatchEffect(() => {
    worker.current?.update(data && data.team_id === teamId ? data.rail ?? [] : [], notifications ?? []);
  }, [data, notifications, teamId, ready]);
}
