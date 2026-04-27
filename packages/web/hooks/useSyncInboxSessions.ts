import { useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession, isSessionWaitingForInput, isSub, isConvexId } from "../store/inboxStore";
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
  const convex = useConvex();
  const showAll = useInboxStore((s) => s.clientState.ui?.show_old_sessions ?? true);
  const inboxSessions = useQuery(api.conversations.listInboxSessions, { show_all: showAll });
  const clientState = useQuery(api.client_state.get, {});
  const bgFetchingRef = useRef(new Set<string>());
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
  const _setDispatchError = useInboxStore((s) => s._setDispatchError);

  const prevActiveIdsRef = useRef<Set<string> | null>(null);
  const prevIdleMapRef = useRef<Map<string, boolean> | null>(null);

  const dispatchRef = useRef(dispatchMutation);
  dispatchRef.current = dispatchMutation;

  useMountEffect(() => {
    _setDispatch((action, args, patches, result) => dispatchRef.current({ action, args, patches, result }));
    _setDispatchError((action, error) => {
      console.error(`[sync] dispatch failed after retries: ${action}`, error);
      useInboxStore.setState(s => ({ dispatchErrors: s.dispatchErrors + 1 }));
    });
  });

  // Background-sync messages for inbox sessions so clicks are instant.
  // When session metadata updates arrive, detect sessions with new messages
  // and fetch the delta from Convex. Results go into the store + IDB via mergeMessages.
  const bgSyncMessages = useCallback((sessions: any[]) => {
    const store = useInboxStore.getState();
    for (const session of sessions) {
      const id = session._id as string;
      if (!isConvexId(id) || bgFetchingRef.current.has(id)) continue;
      const storedMsgs = store.messages[id];
      const storedCount = storedMsgs?.length ?? 0;
      const serverCount = session.message_count ?? 0;
      // Skip if we already have all messages or session is empty
      if (serverCount === 0 || (storedCount > 0 && storedCount >= serverCount)) continue;
      const lastTimestamp = storedCount > 0 ? storedMsgs[storedCount - 1].timestamp : 0;
      bgFetchingRef.current.add(id);
      const fetchPage = async (after: number): Promise<void> => {
        const result = await convex.query(api.conversations.getNewMessages, {
          conversation_id: id as Id<"conversations">,
          after_timestamp: after,
        });
        if (!result?.messages?.length) return;
        useInboxStore.getState().mergeMessages(id, result.messages, "append", { initialized: true });
        if (result.has_more && result.last_timestamp != null) {
          await fetchPage(result.last_timestamp);
        }
      };
      fetchPage(lastTimestamp).finally(() => {
        bgFetchingRef.current.delete(id);
      });
    }
  }, [convex]);

  useConvexSync(inboxSessions, useCallback((data: any) => {
    const sessions = data.sessions ?? data;
    const queued = useInboxStore.getState().sessionsWithQueuedMessages;
    const prev = prevIdleMapRef.current;
    if (prev) {
      for (const s of sessions) {
        if (isSub(s as InboxSession)) continue;
        if (s.inbox_dismissed_at) continue;
        const id = s._id.toString();
        if (isSessionWaitingForInput(s as InboxSession, queued) && prev.has(id) && !prev.get(id)) {
          soundIdle();
          break;
        }
      }
    }
    prevIdleMapRef.current = new Map(
      sessions
        .filter((s: any) => !s.inbox_dismissed_at)
        .map((s: any) => [s._id.toString(), isSessionWaitingForInput(s as InboxSession, queued)])
    );
    syncTable("sessions", sessions as unknown as InboxSession[]);
    if (typeof data.hidden_count === "number") {
      useInboxStore.setState({ hiddenSessionCount: data.hidden_count });
    }
    bgSyncMessages(sessions);
  }, [syncTable, bgSyncMessages]));

  useConvexSync(clientState, useCallback((data: any) => {
    useInboxStore.getState().syncTable("clientState", data);
  }, []));

  // When the current session becomes dismissed elsewhere, hop to its
  // implementation_session if one exists so the user isn't stranded.
  // eslint-disable-next-line no-restricted-syntax -- navigation side effect on session list change
  useEffect(() => {
    if (!inboxSessions) return;
    const sessionsList = (inboxSessions as any).sessions ?? inboxSessions;
    const activeIds = new Set<string>(
      sessionsList.filter((s: any) => !s.inbox_dismissed_at).map((s: any) => s._id.toString())
    );
    const prev = prevActiveIdsRef.current;
    if (prev) {
      const currentSessionId = useInboxStore.getState().currentSessionId;
      const sessions = useInboxStore.getState().sessions;
      const currentSession = currentSessionId ? sessions[currentSessionId] : null;
      if (currentSession && prev.has(currentSession._id) && !activeIds.has(currentSession._id)) {
        const synced = (sessionsList as any[]).find((s) => s._id.toString() === currentSession._id);
        if (synced?.implementation_session) {
          useInboxStore.getState().navigateToSession(synced.implementation_session._id);
        }
      }
    }
    prevActiveIdsRef.current = activeIds;
  }, [inboxSessions]);

  return { activeSessions: inboxSessions };
}
