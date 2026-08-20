// The Threads inbox's sync layer: threads.listMine and threads.unreadCount in,
// store collections out — the same feeder/reader split as useChatSync.
//
// Two feeders: the PAGE's (useThreadsInboxSync, mounted by /threads only) and
// the BADGE's (useThreadUnreadSync, mounted app-wide in DashboardLayout so the
// sidebar count is honest on every page). Neither is chat-gated: comment and
// task threads exist whether or not a team has chat on, and the personal
// workspace (no active team) has its own threads.
//
// Readers subscribe to a wake SIGNATURE of the fields they render, never the
// raw collection ref (store/wakeSig.ts).

import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  useInboxStore,
  useTrackedStore,
  type ChatMessageRow,
  type ChatRailChannel,
  type ThreadInboxRow,
} from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";
import { ingestTaskDetail } from "./useSyncTasks";
import { messagesSig, reactionsSig, useChatMembers, useChatRail, useMessageViews } from "./useChatSync";
import type { ChatMessageView } from "../components/chat/chatTypes";

const api = _api as any;

// ── Signatures ──────────────────────────────────────────────────────────────

/** What the Threads page renders from an entry. */
export const threadInboxSig = makeCollectionSig<ThreadInboxRow>(
  (e) =>
    `${e._id}|${e.kind}|${e.root_key}|${e.team_id ?? ""}|${e.channel_id ?? ""}` +
    `|${e.last_activity_at}|${e.last_read_at}|${e.unread}|${e.unread_capped ? 1 : 0}` +
    `|${e.last_reply?._id ?? ""}|${e.last_reply?.preview ?? ""}`,
);

/** The active workspace, as the server args want it: an explicit team id, or
 *  nothing at all for the personal workspace. Never a guessed team — the
 *  server must not pick one (personal is a value, not a missing pointer). */
function useThreadScope(): { teamId: string | undefined; args: { team_id?: string } } {
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const scoped = !!teamId && isConvexId(teamId);
  return useMemo(
    () => ({ teamId: scoped ? teamId : undefined, args: scoped ? { team_id: teamId } : {} }),
    [teamId, scoped],
  );
}

/** A row belongs to the workspace on screen. Absence normalized on both sides:
 *  a personal row has no team_id and the personal workspace has no team. */
export function threadRowInWorkspace(row: { team_id?: string }, teamId: string | undefined): boolean {
  return String(row.team_id ?? "") === String(teamId ?? "");
}

// ── The page feeder ─────────────────────────────────────────────────────────

/** The newest page of the viewer's threads, live, plus backwards paging.
 *  Mounted by the Threads page only; the badge has its own feeder below.
 *  Entries sync as deltas; the payload fans out to the collections every
 *  other surface already reads — chat roots and rollups, comments, task
 *  detail rows — so the kind renderers paint from the store. */
export function useThreadsInboxSync(): {
  loading: boolean;
  error?: Error;
  /** Re-subscribe after an error (the page's "try again"). */
  retry: () => void;
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
} {
  const { teamId, args } = useThreadScope();
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();
  const { data: result, error, retry } = useQueryNoThrow(api.threads.listMine, args);

  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const teamRef = useRef(teamId);
  if (teamRef.current !== teamId) {
    teamRef.current = teamId;
    if (olderCursor !== null) setOlderCursor(null);
    if (olderExhausted) setOlderExhausted(false);
    if (isLoadingOlder) setIsLoadingOlder(false);
  }

  const ingest = useCallback(
    (data: any) => {
      if (!data) return;
      syncTable("threadInbox", data.entries ?? []);
      const chat = data.payload?.chat;
      if (chat?.roots?.length) syncTable("chatMessages", chat.roots);
      if (chat?.threads?.length) {
        syncTable(
          "chatThreadSummaries",
          chat.threads.map((t: any) => ({ ...t, _id: String(t.root_id) })),
        );
      }
      if (data.payload?.comments?.length) syncTable("comments", data.payload.comments);
      for (const task of data.payload?.tasks ?? []) ingestTaskDetail(task);
    },
    [syncTable],
  );

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        ingest(data);
        if (data) setOlderCursor((prev) => (prev === null ? (data.next_cursor ?? null) : prev));
      },
      [ingest],
    ),
  );

  const loadOlder = useCallback(() => {
    if (!olderCursor || isLoadingOlder || olderExhausted) return;
    const forTeam = teamId;
    setIsLoadingOlder(true);
    void convex
      .query(api.threads.listMine, { ...args, cursor: olderCursor })
      .then((page: any) => {
        if (teamRef.current !== forTeam) return;
        ingest(page);
        setOlderCursor(page?.next_cursor ?? null);
        if (!page?.has_more) setOlderExhausted(true);
      })
      .catch(() => {
        // Leave the cursor: the affordance stays, the next click retries.
      })
      .finally(() => {
        if (teamRef.current === forTeam) setIsLoadingOlder(false);
      });
  }, [convex, teamId, args, olderCursor, isLoadingOlder, olderExhausted, ingest]);

  return {
    loading: result === undefined && !error,
    error,
    retry,
    hasMore: !!olderCursor && !olderExhausted,
    isLoadingOlder,
    loadOlder,
  };
}

// ── The badge feeder ────────────────────────────────────────────────────────

/** The server's count of the viewer's threads with unseen replies, for the
 *  workspace on screen. App-wide (DashboardLayout), so the sidebar badge is
 *  honest before the Threads page has ever mounted. */
export function useThreadUnreadSync(): void {
  const { args } = useThreadScope();
  const syncTable = useInboxStore((s) => s.syncTable);
  const { data } = useQueryNoThrow(api.threads.unreadCount, args);
  useConvexSync(
    data,
    useCallback((n: any) => syncTable("threadUnread", typeof n === "number" ? n : 0), [syncTable]),
  );
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** The viewer's threads for the active workspace, newest activity first.
 *  Reads the STORE (the feeder only fills it), so a revisit paints from cache. */
export function useThreadInbox(): ThreadInboxRow[] {
  const s = useTrackedStore([
    (s: any) => threadInboxSig(s.threadInbox),
    (s: any) => s.clientState?.ui?.active_team_id,
  ]);
  const teamId = s.clientState?.ui?.active_team_id;
  const sig = threadInboxSig(s.threadInbox);
  return useMemo(() => {
    const out: ThreadInboxRow[] = [];
    for (const id in s.threadInbox) {
      const row = s.threadInbox[id] as ThreadInboxRow;
      if (!threadRowInWorkspace(row, teamId)) continue;
      out.push(row);
    }
    return out.sort((a, b) => b.last_activity_at - a.last_activity_at);
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, teamId]);
}

/** The sidebar badge: how many threads in this workspace have unseen replies.
 *  Server kinds come from the local rows once the page has synced them (they
 *  clear the instant a thread is read); the app-wide scalar stands in until
 *  then. Plus unread, unmuted DMs from the chat rail — the Threads page lists
 *  those as cards too, and the badge must equal its header count. Sessions
 *  never count: their number is the Inbox's. */
export function useThreadUnread(): number {
  const rail = useChatRail();
  const s = useTrackedStore([
    (s: any) => threadInboxSig(s.threadInbox),
    (s: any) => s.threadUnread,
    (s: any) => s.clientState?.ui?.active_team_id,
  ]);
  const teamId = s.clientState?.ui?.active_team_id;
  const sig = threadInboxSig(s.threadInbox);
  const scalar = (s as any).threadUnread ?? 0;
  return useMemo(() => {
    let local = 0;
    let haveLocal = false;
    for (const id in s.threadInbox) {
      const row = s.threadInbox[id] as ThreadInboxRow;
      if (!threadRowInWorkspace(row, teamId)) continue;
      haveLocal = true;
      if ((row.unread ?? 0) > 0) local++;
    }
    let dms = 0;
    for (const c of rail) if (c.kind === "dm" && (c.unreadCount ?? 0) > 0 && !c.muted) dms++;
    return (haveLocal ? local : scalar) + dms;
    // The signature gates the wake; the body reads the raw collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail, sig, scalar, teamId]);
}

export type ThreadInboxCard = {
  entry: ThreadInboxRow;
  /** The root, ready to render — null while the cache is genuinely cold. */
  root: ChatMessageView | null;
  /** The rail's view of the thread's room: display name, DM roster, team. */
  channel: ChatRailChannel | undefined;
};

/** The chat thread cards: entry + rendered root + room, assembled here so the
 *  view stays presentational. One store subscription for every card — a
 *  per-card reader would recompute a full-collection signature per push per
 *  card. Chat kind only; the other kinds have their own renderers. */
export function useThreadInboxCards(): ThreadInboxCard[] {
  const entries = useThreadInbox();
  const rail = useChatRail();
  const { byId, viewerId } = useChatMembers();
  const s = useTrackedStore([
    (s: any) => messagesSig(s.chatMessages),
    (s: any) => reactionsSig(s.chatReactions),
    (s: any) => s.chatThreadSummaries,
  ]);
  const chatEntries = useMemo(() => entries.filter((e) => e.kind === "chat"), [entries]);
  const rootRows = useMemo(
    () =>
      chatEntries
        .map((e) => (s.chatMessages as Record<string, ChatMessageRow>)[e.root_key])
        .filter(Boolean) as ChatMessageRow[],
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatEntries, messagesSig(s.chatMessages)],
  );
  const views = useMessageViews(rootRows, s.chatReactions, byId, viewerId, s.chatMessages, s.chatThreadSummaries);
  return useMemo(() => {
    const viewById = new Map(views.map((v) => [v.id, v]));
    const railById = new Map(rail.map((c) => [c.id, c]));
    return chatEntries.map((entry) => ({
      entry,
      root: viewById.get(entry.root_key) ?? null,
      channel: railById.get(String(entry.channel_id ?? "")),
    }));
  }, [chatEntries, views, rail]);
}
