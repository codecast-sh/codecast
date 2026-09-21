import { useRef } from "react";
import { useConvex } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type ChatRailRow } from "../store/inboxStore";
import { createChatPrefetcher } from "../lib/chatPrefetch";
import { CHAT_PAGE_SIZE, ingestChatPage } from "../lib/ingestChatPage";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

/** Fills the store with the chat rows a notification will open (lib/chatPrefetch).
 *  Mounted by the team rail feeder, so it runs on the sync host alone; other
 *  windows receive the rows over replication. `rail` is the feeder's own push. */
export function useChatPrefetch(push: { team_id?: string; rail?: ChatRailRow[] } | undefined, enabled: boolean) {
  const convex = useConvex();
  const viewerId = useInboxStore(s => s.currentUser?._id);
  const teamId = useInboxStore(s => s.clientState.ui?.active_team_id);
  const ready = enabled && !!viewerId && !!teamId;
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
    worker.current?.update(push && push.team_id === teamId ? push.rail ?? [] : [], notifications ?? []);
  }, [push, notifications, teamId, ready]);
}
