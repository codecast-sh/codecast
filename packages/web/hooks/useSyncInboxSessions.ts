import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, InboxSession } from "../store/inboxStore";

export function useSyncInboxSessions(showAll: boolean) {
  const activeSessions = useQuery(api.conversations.listIdleSessions, { show_all: showAll });
  const dismissedQuery = useQuery(api.conversations.listDismissedSessions, {});
  const clientState = useQuery(api.client_state.get, {});
  const dispatchMutation = useMutation(api.dispatch.dispatch);

  const syncSessionsFromConvex = useInboxStore((s) => s.syncSessionsFromConvex);
  const syncDismissedFromConvex = useInboxStore((s) => s.syncDismissedFromConvex);
  const _setDispatch = useInboxStore((s) => s._setDispatch);

  useEffect(() => {
    _setDispatch((action, args, patches) => dispatchMutation({ action, args, patches }));
  }, [dispatchMutation, _setDispatch]);

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

  useEffect(() => {
    if (clientState) {
      useInboxStore.getState().syncClientState(clientState);
    }
  }, [clientState]);

  return { activeSessions };
}
