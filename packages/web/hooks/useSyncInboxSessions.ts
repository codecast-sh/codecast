import { useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, InboxSession, isSessionWaitingForInput, isSub } from "../store/inboxStore";
import { soundIdle } from "../lib/sounds";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function useSyncInboxSessions() {
  const showAll = useInboxStore((s) => s.clientState.ui?.show_old_sessions ?? true);
  const activeSessions = useQuery(api.conversations.listIdleSessions, { show_all: showAll });
  const dismissedQuery = useQuery(api.conversations.listDismissedSessions, {});
  const clientState = useQuery(api.client_state.get, {});
  const dispatchMutation = useMutation(api.dispatch.dispatch).withOptimisticUpdate(
    (localStore, { patches }) => {
      if (!patches?.client_state) return;
      const current = localStore.getQuery(api.client_state.get, {});
      if (!current) return;
      const updates = (patches.client_state as any)._;
      if (!updates) return;
      localStore.setQuery(api.client_state.get, {}, deepMerge(current, updates));
    }
  );

  const syncTable = useInboxStore((s) => s.syncTable);
  const _setDispatch = useInboxStore((s) => s._setDispatch);

  const prevActiveIdsRef = useRef<Set<string> | null>(null);
  const prevIdleMapRef = useRef<Map<string, boolean> | null>(null);

  const dispatchRef = useRef(dispatchMutation);
  dispatchRef.current = dispatchMutation;

  useMountEffect(() => {
    _setDispatch((action, args, patches) => dispatchRef.current({ action, args, patches }));
  });

  useConvexSync(activeSessions, useCallback((data: any) => {
    const sessions = data.sessions ?? data;
    const queued = useInboxStore.getState().sessionsWithQueuedMessages;
    const prev = prevIdleMapRef.current;
    if (prev) {
      for (const s of sessions) {
        if (isSub(s as InboxSession)) continue;
        const id = s._id.toString();
        if (isSessionWaitingForInput(s as InboxSession, queued) && prev.has(id) && !prev.get(id)) {
          soundIdle();
          break;
        }
      }
    }
    prevIdleMapRef.current = new Map(sessions.map((s: any) => [s._id.toString(), isSessionWaitingForInput(s as InboxSession, queued)]));
    syncTable("sessions", sessions as unknown as InboxSession[]);
    if (typeof data.hidden_count === "number") {
      useInboxStore.setState({ hiddenSessionCount: data.hidden_count });
    }
  }, [syncTable]));

  useConvexSync(dismissedQuery, useCallback((data: any) => {
    syncTable("dismissedSessions", data as unknown as InboxSession[]);
  }, [syncTable]));

  useConvexSync(clientState, useCallback((data: any) => {
    useInboxStore.getState().syncTable("clientState", data);
  }, []));

  // eslint-disable-next-line no-restricted-syntax -- navigation side effect on session list change
  useEffect(() => {
    if (!activeSessions || !dismissedQuery) return;
    const sessionsList = (activeSessions as any).sessions ?? activeSessions;
    const activeIds = new Set<string>(sessionsList.map((s: any) => s._id.toString()));
    const prev = prevActiveIdsRef.current;
    if (prev) {
      const currentSessionId = useInboxStore.getState().currentSessionId;
      const sessions = useInboxStore.getState().sessions;
      const currentSession = currentSessionId ? sessions[currentSessionId] : null;
      if (currentSession && prev.has(currentSession._id) && !activeIds.has(currentSession._id)) {
        const dismissedSessions = useInboxStore.getState().dismissedSessions;
        const dismissed = Object.values(dismissedSessions).find((s) => s._id === currentSession._id);
        if (dismissed?.implementation_session) {
          useInboxStore.getState().navigateToSession(dismissed.implementation_session._id);
        }
      }
    }
    prevActiveIdsRef.current = activeIds;
  }, [activeSessions, dismissedQuery]);

  return { activeSessions };
}
