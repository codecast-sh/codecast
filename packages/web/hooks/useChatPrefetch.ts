import { useRef, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { createChatPrefetcher } from "../lib/chatPrefetch";
import { CHAT_PAGE_SIZE, ingestChatPage } from "../lib/ingestChatPage";
import { isChatRailLive, subscribeChatRailLive } from "../lib/chatLive";
import { isConvexId } from "../lib/entityLinks";
import { useTeamFeature } from "../lib/teamFeatures";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

/** Fills the store with the chat rows a notification will open (lib/chatPrefetch).
 *  Mount on the sync host only; other windows receive the rows over
 *  replication. Reads the rail the team feeder keeps in the store, and waits
 *  for the server's first answer: the rail on disk is last session's, and its
 *  stale tips would only cost fetches the live rail then repeats. */
export function useChatPrefetch(): void {
  const convex = useConvex();
  const viewerId = useInboxStore(s => s.currentUser?._id);
  const teamId = useInboxStore(s => s.clientState.ui?.active_team_id) as string | undefined;
  const rail = useInboxStore(s => s.chatRail);
  const chatOn = useTeamFeature("chat");
  const railLive = useSyncExternalStore(subscribeChatRailLive, isChatRailLive, () => false);
  const ready = chatOn && railLive && !!viewerId && !!teamId && isConvexId(teamId);
  // The bell and the desktop banner subscribe to the same query with the same
  // args, and the client shares one subscription among them: this adds none.
  const { data: notifications } = useQueryNoThrow(api.notifications.list, ready ? {} : "skip");
  const worker = useRef<ReturnType<typeof createChatPrefetcher> | null>(null);

  useWatchEffect(() => {
    if (!ready) return;
    const current = createChatPrefetcher({
      load: target => target.kind === "channel"
        ? convex.query(api.chat.listMessages, { channel_id: target.id as any, limit: CHAT_PAGE_SIZE })
        : target.kind === "thread"
          ? convex.query(api.chat.getThread, { root_id: target.id as any })
          : convex.query(api.chat.getMessage, { message_id: target.id as any }),
      ingest: data => ingestChatPage(data, convex),
      read: id => useInboxStore.getState().chatMessages[id],
      allowed: () => {
        const s = useInboxStore.getState();
        return s.currentUser?._id === viewerId && s.clientState.ui?.active_team_id === teamId && s.syncRole !== "follower";
      },
      onError: error => captureException(error, { tags: { operation: "chat-prefetch" } }),
    });
    worker.current = current;
    return () => { current.dispose(); worker.current = null; };
  }, [convex, viewerId, teamId, ready]);

  useWatchEffect(() => {
    // The workspace's rooms only: the rail also carries the public community
    // rooms, which no notification of this viewer names.
    const channels = useInboxStore.getState().chatChannels;
    worker.current?.update((rail ?? []).filter(row => String(channels[row.channel_id]?.team_id) === String(teamId)), notifications ?? []);
  }, [rail, notifications, teamId, ready]);
}
