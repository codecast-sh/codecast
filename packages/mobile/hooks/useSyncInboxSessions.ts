import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type InboxSession } from "@codecast/web/store/inboxStore";

export function useSyncInboxSessions() {
  const activeSessions = useQuery(api.conversations.listIdleSessions, { show_all: true });
  const dismissedQuery = useQuery(api.conversations.listDismissedSessions, {});
  const dispatchMutation = useMutation(api.dispatch.dispatch);

  const syncTable = useInboxStore((s) => s.syncTable);
  const _setDispatch = useInboxStore((s) => s._setDispatch);

  useEffect(() => {
    _setDispatch((action, args, patches) => dispatchMutation({ action, args, patches }));
  }, [dispatchMutation, _setDispatch]);

  useEffect(() => {
    if (activeSessions) {
      const sessions = (activeSessions as any).sessions ?? activeSessions;
      syncTable("sessions", sessions as unknown as InboxSession[]);
    }
  }, [activeSessions, syncTable]);

  useEffect(() => {
    if (dismissedQuery) {
      syncTable("dismissedSessions", dismissedQuery as unknown as InboxSession[]);
    }
  }, [dismissedQuery, syncTable]);
}
