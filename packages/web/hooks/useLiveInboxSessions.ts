import { useCallback, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, InboxSession } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

// Record the live (recent) id set, change-guarded so an identical payload doesn't
// allocate a new Set and re-render every subscriber. "Old" = cached top-level
// sessions absent from this set (filled by the completeness crawl). Exported as a
// plain function (no React deps — it reads/writes the store directly) so the
// recovery poll in useSyncInboxSessions can reuse it.
export function applyLiveInboxIds(sessions: any[]) {
  const next = new Set<string>(sessions.map((x: any) => x._id.toString()));
  const prev = useInboxStore.getState().liveInboxIds;
  if (prev.size === next.size && [...next].every((id) => prev.has(id))) return;
  useInboxStore.setState({ liveInboxIds: next });
}

/**
 * The ONE live source of truth for the inbox `sessions` cache: the
 * listInboxSessions subscription piped into syncTable + liveInboxIds.
 *
 * Both surfaces that need a current view of the session set mount this — the full
 * inbox hook (useSyncInboxSessions, which layers recovery polling / liveness /
 * the reconcile crawl on top) and the standalone palette window (which wants
 * nothing else). Sharing this is the whole point: a window that decides which
 * blank session to reuse (findReusableBlankSession) MUST see the same `sessions`
 * truth as the in-app New Session, or it routes the first message into a session
 * that only LOOKS blank in a stale IDB snapshot — the desktop "compose into an
 * existing session" bug. include_liveness:false matches useSyncInboxSessions so
 * the two callers share Convex's query cache instead of forking a second token.
 *
 * Returns the raw subscription result (undefined until the first server response)
 * for callers that need the live payload itself.
 */
export function useLiveInboxSessions(opts?: { onSync?: (sessions: any[]) => void }) {
  const inboxSessions = useQuery(api.conversations.listInboxSessions, { show_all: false, include_liveness: false });
  const syncTable = useInboxStore((s) => s.syncTable);
  const onSyncRef = useRef(opts?.onSync);
  onSyncRef.current = opts?.onSync;

  useConvexSync(inboxSessions, useCallback((data: any) => {
    const sessions = data.sessions ?? data;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    applyLiveInboxIds(sessions);
    onSyncRef.current?.(sessions);
  }, [syncTable]), { coalesceMs: 300 });

  return inboxSessions;
}
