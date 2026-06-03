import { useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession, isSessionWaitingForInput, isSub, isConvexId } from "../store/inboxStore";
import { soundIdle } from "../lib/sounds";
import { useConvexSync } from "./useConvexSync";
import { useRecoveryPoll } from "./useRecoveryPoll";
import { useEnsureDispatch } from "./useEnsureDispatch";

export function useSyncInboxSessions() {
  // Wire the store's server dispatch (split out so a screen can ensure dispatch
  // without these inbox subscriptions — see useEnsureDispatch).
  useEnsureDispatch();

  const convex = useConvex();
  const showAll = useInboxStore((s) => s.clientState.ui?.show_old_sessions ?? true);
  const inboxSessions = useQuery(api.conversations.listInboxSessions, { show_all: showAll });
  const clientState = useQuery(api.client_state.get, {});
  const currentUser = useQuery(api.users.getCurrentUser);
  const bgFetchingRef = useRef(new Set<string>());

  const syncTable = useInboxStore((s) => s.syncTable);
  const pruneDrafts = useMutation(api.client_state.pruneDeadDrafts);
  const prunedRef = useRef(false);

  const prevActiveIdsRef = useRef<Set<string> | null>(null);
  const prevIdleMapRef = useRef<Map<string, boolean> | null>(null);
  const lastSyncRef = useRef(Date.now());
  const lastUserSyncRef = useRef(Date.now());

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
    lastSyncRef.current = Date.now();
  }, [syncTable, bgSyncMessages]), { coalesceMs: 300 });

  useConvexSync(clientState, useCallback((data: any) => {
    useInboxStore.getState().syncTable("clientState", data);
    // One-time self-heal: if the server's client_state has accumulated more
    // drafts than Convex can patch (>~1000), prune dead entries. Otherwise
    // every subsequent dispatch that touches client_state would fail with
    // "Object has too many fields".
    if (!prunedRef.current && data?.drafts && typeof data.drafts === "object") {
      const draftCount = Object.keys(data.drafts).length;
      if (draftCount > 800) {
        prunedRef.current = true;
        pruneDrafts({}).catch((e) => console.error("[sync] prune drafts failed", e));
      }
    }
  }, [pruneDrafts]));

  useConvexSync(currentUser, useCallback((data: any) => {
    useInboxStore.getState().syncTable("currentUser", data);
    lastUserSyncRef.current = Date.now();
  }, []));

  // Recovery heartbeat: a Convex subscription can silently stall after
  // sleep/wake or WebSocket reconnection, and each one stalls independently.
  // Poll a one-shot query to catch divergence — same pattern as
  // useConversationMessages' watermark loop.
  useRecoveryPoll(lastSyncRef, useCallback(async () => {
    // `_probe` makes this a novel query token so Convex round-trips instead of
    // serving the (possibly stalled) cache of the live listInboxSessions
    // subscription — otherwise the "recovery" just re-reads the staleness.
    const fresh: any = await convex.query(api.conversations.listInboxSessions, { show_all: showAll, _probe: Date.now() });
    if (!fresh) return;
    const sessions = fresh.sessions ?? fresh;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    if (typeof fresh.hidden_count === "number") {
      useInboxStore.setState({ hiddenSessionCount: fresh.hidden_count });
    }
    bgSyncMessages(sessions);
    lastSyncRef.current = Date.now();
  }, [convex, showAll, syncTable, bgSyncMessages]), 15_000);

  // currentUser carries daemon_last_seen — the input to the CLI-offline banner.
  // Its subscription stalls independently of listInboxSessions (sessions can
  // keep syncing while the user doc freezes), which made the banner climb a
  // false "offline for Nh" while the daemon was healthy. The daemon refreshes
  // this every ~30s via heartbeat, so a 45s gap means the subscription stalled.
  //
  // Probe via getCurrentUserProbe, NOT getCurrentUser: ConvexReactClient.query()
  // returns the locally-cached result of any live subscription sharing the
  // (fn, args) token, so a bare getCurrentUser() probe reads back the exact
  // stale value it's meant to replace. getCurrentUserProbe has no live
  // subscriber, so its token is never cached and this always round-trips.
  useRecoveryPoll(lastUserSyncRef, useCallback(async () => {
    const fresh: any = await convex.query(api.users.getCurrentUserProbe, { _probe: Date.now() });
    if (fresh === undefined) return;
    useInboxStore.getState().syncTable("currentUser", fresh);
    lastUserSyncRef.current = Date.now();
  }, [convex]), 45_000);

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
