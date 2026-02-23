import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession } from "../store/inboxStore";

export function useSyncInboxSessions(showAll: boolean) {
  const activeSessions = useQuery(api.conversations.listIdleSessions, { show_all: showAll });
  const dismissedQuery = useQuery(api.conversations.listDismissedSessions, {});
  const patchConv = useMutation(api.conversations.patchConversation);

  const syncSessionsFromConvex = useInboxStore((s) => s.syncSessionsFromConvex);
  const syncDismissedFromConvex = useInboxStore((s) => s.syncDismissedFromConvex);
  const registerMutation = useInboxStore((s) => s.registerMutation);

  useEffect(() => {
    registerMutation("conversations", (id, fields) =>
      patchConv({ id: id as Id<"conversations">, fields })
    );
  }, [patchConv, registerMutation]);

  useEffect(() => {
    if (activeSessions) {
      syncSessionsFromConvex(activeSessions as unknown as InboxSession[]);
    }
  }, [activeSessions, syncSessionsFromConvex]);

  useEffect(() => {
    if (dismissedQuery) {
      syncDismissedFromConvex(dismissedQuery as unknown as InboxSession[]);
    }
  }, [dismissedQuery, syncDismissedFromConvex]);

  return { activeSessions };
}
